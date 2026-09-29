#!/usr/bin/env node
/**
 * TeXHub Yjs 覆盖写（main.tex 专用）—— 不硬等 step2，且写前先确认服务端 doc 长度。
 *
 * 为什么不用 tools/texhub-yjs.mjs：
 *   1. 它的 connectAndSync() 只有收到 messageYjsSyncStep2 才 resolve，
 *      而 main.tex（main_flag=1）的握手经常收不到 step2（见 docs/texhub/03-write.md 3.6.5），
 *      于是必然 20s 超时抛错；
 *   2. 它的 waitAck() 等的 sync:ack 协议在服务端源码里根本不存在（见 3.6.3）。
 *
 * 为什么必须先查长度（见 3.6.5.0）：
 *   write 的语义是 delete(0, len) + insert(0, incoming)。若本地 Y.Doc 尚未与服务端
 *   同步（text.length === 0），delete 是空操作，发出的 update 就是"在位置 0 插入 N 字符"，
 *   服务端**不会删除任何旧内容** → 内容翻倍且不可逆。
 *
 * 为什么不能只看 Yjs 读到的长度（3.6.5.0 补充，本脚本 2026-09-28 加固）：
 *   main.tex（main_flag=1）首次握手经常**收不到 step2**，Yjs 读出 length 0，
 *   而 REST /tex/file/download 显示磁盘上明明有 Ls 个字符。
 *   若把"Yjs 读到 0"当成"服务端为空"，第二轮同样可能读到 0 → delete 空操作 → 内容翻倍。
 *   故本脚本以 **REST download 的字符数 Ls 为准绳**，反复开新会话直到某轮
 *   Yjs 读到的长度与 Ls 相等，才允许进入写入轮；写入轮内部再次断言，长度不符即中止。
 *
 * 用法：
 *   node tools/texhub-yjs-write.mjs <fileId> <本地文件>
 *   node tools/texhub-yjs-write.mjs e1b186dc16b84c3c8f8489ee139dab20 main.tex
 *   node tools/texhub-yjs-write.mjs <fileId> <本地文件> --allow-empty-doc
 *
 *   --allow-empty-doc：仅用于**经 REST 上传创建**的文件。这类文件磁盘上有正文，
 *   但 Yjs doc 从未被 seeding（doc 长度恒为 0），于是"REST 长度 == Yjs 长度"
 *   这条判据永远不成立。传此开关前**必须**先用只读探针（probe-read.mjs）
 *   独立确认该 doc 长度确为 0；确认后写入等价于"向空 doc 插入完整正文"，
 *   不是追加，故不会翻倍。
 *
 * 环境变量：
 *   TEXHUB_TOKEN=<accessToken>   必填（4 小时有效，每轮现取，见 docs/texhub/01-auth.md 1.2）
 *   TEXHUB_PROJ=<projectId>      默认 1ca9d4b0e5734ed1b5d122df09a265f4
 *   SOCKET_URL=https://socket.poemhub.top/texhub
 *
 * 依赖版本需与 texhub-broadcast 一致：
 *   socket.io-client@4.8.4  yjs@13.6.33  y-protocols@1.0.7  lib0@0.2.117
 * ⚠️ texhub-broadcast 目录下的 node_modules 是失效的 pnpm 软链，借用会 Cannot find module；
 *    需自行 npm i 到一个真实目录，把本脚本拷进去运行（见 03-write.md 3.6.5.2）。
 *
 * 退出码：0 写入并回显完成（或本来就一致）；3 长度始终对不上，已中止；1 出错。
 * 注意：本脚本的"完成"不等于"落库"。最终以编译后的
 * GET /tex/file/download?file_id= 与本地文件 SHA256 比对为准。
 */

import { io } from "socket.io-client";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { readFileSync } from "node:fs";

const SOCKET_URL = process.env.SOCKET_URL ?? "https://socket.poemhub.top/texhub";
const PROJ = process.env.TEXHUB_PROJ ?? "1ca9d4b0e5734ed1b5d122df09a265f4";
const TOKEN = process.env.TEXHUB_TOKEN ?? "";
const API = process.env.TEXHUB_API ?? "https://tex.poemhub.top";

// 与 backend/texhub-broadcast/src/model/texhub/sync_msg_type.ts 的 MessageSync 一致。
// 注意区分 SubDocMessageSync = 22（网页编辑器走那条，额外带 varString JSON 头），
// 这里用的是 messageListener 里完整支持的纯 Yjs 分支。
const MSG_SYNC = 0;
const REMOTE = "server";
const ALLOW_EMPTY_DOC = process.argv.includes("--allow-empty-doc");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYNC_NAMES = { 0: "Step1", 1: "Step2", 2: "Update" };

/** varuint(MSG_SYNC) + writeUpdate(增量) */
function frameUpdate(update) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

/** socket.io 偶尔把二进制帧序列化成 {type:'Buffer',data:[…]}，必须归一化 */
function toU8(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(raw)) return new Uint8Array(raw);
  if (Array.isArray(raw)) return Uint8Array.from(raw);
  if (raw && Array.isArray(raw.data)) return Uint8Array.from(raw.data);
  if (raw && raw.data) return toU8(raw.data);
  throw new Error(`无法识别的帧类型: ${Object.prototype.toString.call(raw)}`);
}

function socketOptions(docId) {
  return {
    withCredentials: true,
    reconnection: false,
    // 只给 ["websocket"] 会在 openresty 后挂掉（connect_error: timeout）
    transports: ["websocket", "polling"],
    tryAllTransports: true,
    path: "/sync",
    auth: { token: TOKEN },
    timeout: 20000,
    // 服务端 setupWSConnection 从 URL query 读取这些参数
    query: {
      access_token: TOKEN,
      docId,
      docIntId: docId,
      docShowName: docId,
      enableSid: false,
      projId: PROJ,
      docType: 1, // TeXFileType.TEX
    },
  };
}

/**
 * 开一个会话：连上 → 发 step1 → 收集帧 → 可选地 mutate → 返回。
 * 不以"收到 step2"作为结束条件，而是固定等待，避免 main.tex 卡死。
 */
async function session(label, docId, mutate, expectLen) {
  const ydoc = new Y.Doc();
  const text = ydoc.getText(docId); // 文本名 == docId，见 yjs_utils.ts:128
  const socket = io(SOCKET_URL, socketOptions(docId));

  ydoc.on("update", (update, origin) => {
    if (origin === REMOTE) return;
    socket.emit("message", frameUpdate(update));
    console.log(`  [${label}] pushed update, ${update.length} bytes`);
  });

  await new Promise((res, rej) => {
    socket.on("connect", res);
    socket.on("connect_error", (e) => rej(new Error(e.message)));
    setTimeout(() => rej(new Error("connect timeout 25s")), 25000);
  });
  console.log(`  [${label}] connected`);

  const step1 = encoding.createEncoder();
  encoding.writeVarUint(step1, MSG_SYNC);
  syncProtocol.writeSyncStep1(step1, ydoc);
  socket.emit("message", encoding.toUint8Array(step1));

  socket.on("message", (raw) => {
    try {
      const buf = toU8(raw);
      const dec = decoding.createDecoder(buf);
      if (decoding.readVarUint(dec) !== MSG_SYNC) return; // awareness/control 与正文无关
      const rep = encoding.createEncoder();
      encoding.writeVarUint(rep, MSG_SYNC);
      const st = syncProtocol.readSyncMessage(dec, rep, ydoc, REMOTE);
      console.log(
        `  [${label}] recv ${SYNC_NAMES[st] ?? st} len=${buf.length} docLen=${text.length}`
      );
      if (encoding.length(rep) > 1) socket.emit("message", encoding.toUint8Array(rep));
    } catch (e) {
      console.log(`  [${label}] frame err ${e.message}`);
    }
  });

  await sleep(3000);
  const before = text.length;
  console.log(`  [${label}] doc length before = ${before}`);
  if (typeof expectLen === "number" && before !== expectLen) {
    // 特例：经 REST 上传创建的文件，磁盘有正文但 Yjs doc 从未被 seeding，
    // 此时 REST 长度不是正确判据（doc 真的就是空的）。必须由调用方显式
    // 传 --allow-empty-doc 并先用只读探针独立确认过 doc 长度为 0 才放行。
    if (!(ALLOW_EMPTY_DOC && before === 0)) {
      socket.close();
      ydoc.destroy();
      throw new Error(
        `长度断言失败：Yjs 读到 ${before}，REST download 为 ${expectLen}。已中止，未做任何修改。`
      );
    }
    console.log(
      `  [${label}] !! --allow-empty-doc 生效：Yjs doc 确认为空（0），` +
        `磁盘的 ${expectLen} 字符不在 CRDT 内。即将以 insert 写入完整正文（非追加，不翻倍）。`
    );
  }
  if (mutate) {
    ydoc.transact(() => {
      if (text.length) text.delete(0, text.length);
      text.insert(0, mutate);
    }, "ai-client");
  }
  // 留出时间让服务端 apply + 持久化
  await sleep(6000);
  console.log(`  [${label}] doc length after  = ${text.length}`);

  socket.close();
  ydoc.destroy();
  return before;
}

async function main() {
  const docId = process.argv[2];
  const localPath = process.argv[3];
  if (!TOKEN) throw new Error("缺少 TEXHUB_TOKEN 环境变量");
  if (!docId) throw new Error('缺少 <fileId>（用 GET /tex/file/tree?parent=<projectId> 查）');
  if (!localPath) throw new Error("缺少 <本地文件路径>");

  const incoming = readFileSync(localPath, "utf8");
  console.log(`payload: ${incoming.length} chars from ${localPath}`);

  // 以 REST download 的磁盘内容长度为准绳。Yjs 单次握手可能收不到 step2 而读到 0，
  // 那个 0 是"还没同步上"，不是"服务端为空"——两者必须区分，否则会翻倍。
  const res = await fetch(`${API}/tex/file/download?file_id=${docId}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`REST download 失败 HTTP ${res.status}`);
  const serverText = await res.text();
  const Ls = serverText.length;
  console.log(`REST download: ${Ls} chars (磁盘现状)`);
  if (serverText === incoming) {
    console.log("服务端已与本地一致，无需写入。");
    return 0;
  }

  // 只读轮：反复开新会话，直到某轮 Yjs 读到的长度 == Ls。main.tex 首轮常为 0。
  let synced = false;
  for (let i = 1; i <= 4 && !synced; i++) {
    try {
      await session(`read#${i}`, docId, null, Ls);
      synced = true;
    } catch (e) {
      console.log(`  [read#${i}] ${e.message} → 重开新会话`);
    }
  }
  if (!synced) {
    console.error(
      `ABORT: 连续 4 轮 Yjs 读到的长度都对不上 REST 的 ${Ls} 字符。\n` +
        `无法确认服务端 doc 状态，覆盖写会导致内容翻倍且不可逆，故中止。`
    );
    return 3;
  }

  // 写入轮：内部再断言一次长度 == Ls，确保 delete 删的正是服务端旧内容。
  // 同样可能收不到 step2（docLen 读成 0）——此时必须重开新会话，绝不能带着
  // docLen=0 去发 delete(0,0)+insert(0,N)，那会让内容翻倍且不可逆。
  let written = false;
  for (let i = 1; i <= 6 && !written; i++) {
    try {
      await session(`write#${i}`, docId, incoming, Ls);
      written = true;
    } catch (e) {
      console.log(`  [write#${i}] ${e.message} → 重开新会话`);
      await sleep(1500);
    }
  }
  if (!written) {
    console.error(`ABORT: 连续 6 轮写入会话都没能确认服务端 doc 长度 = ${Ls}，未做任何修改。`);
    return 3;
  }
  console.log("done. 请以编译后 GET /tex/file/download 的 SHA256 比对为准。");
  return 0;
}

main()
  .then((c) => process.exit(c ?? 0))
  .catch((e) => {
    console.error("错误:", e.message);
    process.exit(1);
  });
