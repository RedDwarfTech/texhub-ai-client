#!/usr/bin/env node
/**
 * TeXHub Yjs 协同通道客户端 —— 绕过 REST，直接读写文档正文。
 *
 * 背景：texhub-server 的公开 REST API 无法修改已有文件内容（见 TEXHUB_API.md 第 5 节），
 * 唯一真正的写入通道是 socket.io + Yjs 协议。本脚本是该协议的最小客户端实现。
 *
 * 用法：
 *   node tools/texhub-yjs.mjs probe
 *   node tools/texhub-yjs.mjs read
 *   node tools/texhub-yjs.mjs write    --file <fileId> --local <path>
 *   node tools/texhub-yjs.mjs append   --file <fileId> --local <path>
 *
 * 环境变量：
 *   TEXHUB_TOKEN=<accessToken>   必填
 *   TEXHUB_PROJ=<projectId>      默认 1ca9d4b0e5734ed1b5d122df09a265f4
 *   SOCKET_URL=https://socket.poemhub.top/texhub
 *
 * 依赖版本需与 texhub-broadcast 一致：
 *   socket.io-client@4.8.4  yjs@13.6.33  y-protocols@1.0.7  lib0@0.2.117
 * 运行示例（在 texhub-broadcast 目录下借用其 node_modules）：
 *   cd /Users/dolphin/Documents/GitHub/texhub-ai/backend/texhub-broadcast \
 *     && TEXHUB_TOKEN=... node /Users/dolphin/Documents/GitHub/gd-fire/tools/texhub-yjs.mjs read --file <id>
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

// 与 backend/texhub-broadcast/src/model/texhub/sync_msg_type.ts 保持一致
const MSG_SYNC = 0;
const ORIGIN_REMOTE = "server"; // 标记来自服务端的更新，避免回声

/** varuint(MSG_SYNC) + writeUpdate(增量) */
function frameUpdate(update) {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeUpdate(enc, update);
  return encoding.toUint8Array(enc);
}

/** 把任意形态的 socket.io 二进制负载归一化成 Uint8Array */
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
    // 必须与 CollarEditorSocketIOService.ts 一致。实测只填 ["websocket"] 会在
    // openresty 后挂掉（connect_error: timeout）；加上 polling + tryAllTransports 才通。
    withCredentials: true,
    reconnection: false,
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
 * 建连并完成 Yjs 双向握手。resolve 时 ydoc 内容已与服务端一致。
 */
function connectAndSync(docId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ydoc = new Y.Doc();
    const text = ydoc.getText(docId); // 文本名 == docId，见 yjs_utils.ts:128
    const socket = io(SOCKET_URL, socketOptions(docId));

    // 本地改动 → 推给服务端（origin 为 server 的一律不回声）
    ydoc.on("update", (update, origin) => {
      if (origin === ORIGIN_REMOTE) return;
      socket.emit("message", frameUpdate(update));
    });

    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        socket.close();
        ydoc.destroy();
        reject(err);
      } else {
        resolve({ socket, ydoc, text, disconnect: () => socket.close() });
      }
    };
    const timer = setTimeout(
      () => finish(new Error(`同步超时 ${timeoutMs}ms（检查 token / docId / 网络）`)),
      timeoutMs
    );

    socket.on("connect", () => {
      // 客户端发 step1，促使服务端回 step2
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeSyncStep1(enc, ydoc);
      socket.emit("message", encoding.toUint8Array(enc));
    });

    socket.on("message", (raw) => {
      try {
        // socket.io 偶尔把二进制帧序列化成 {type:'Buffer',data:[…]}，
        // 直接 new Uint8Array(raw) 会得到长度 0 并在解码时静默抛错，必须归一化
        const buf = toU8(raw);
        const dec = decoding.createDecoder(buf);
        if (decoding.readVarUint(dec) !== MSG_SYNC) return; // awareness/control 与正文无关
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MSG_SYNC);
        const syncType = syncProtocol.readSyncMessage(dec, enc, ydoc, ORIGIN_REMOTE);
        if (encoding.length(enc) > 1) socket.emit("message", encoding.toUint8Array(enc));
        if (syncType === syncProtocol.messageYjsSyncStep2) finish(null);
      } catch (e) {
        finish(new Error(`帧解码失败: ${e.message}`));
      }
    });

    socket.on("connect_error", (e) => finish(new Error(`连接失败: ${e.message}`)));
    socket.on("auth_error", (e) => finish(new Error(`鉴权失败: ${String(e)}`)));
  });
}

/** 等待服务端确认某个 doc 的更新已落库（ws_action.ts 的 sync:ack / sync:nack） */
function waitAck(socket, docId, seq, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off("sync:ack", onAck);
      socket.off("sync:nack", onNack);
      reject(new Error(`等待 sync:ack 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    const onAck = (p) => {
      if (p?.doc !== docId) return;
      clearTimeout(t);
      socket.off("sync:nack", onNack);
      resolve(p);
    };
    const onNack = (p) => {
      if (p?.doc !== docId) return;
      clearTimeout(t);
      socket.off("sync:ack", onAck);
      reject(new Error(`服务端拒绝: ${p.reason}`));
    };
    socket.on("sync:ack", onAck);
    socket.on("sync:nack", onNack);
    void seq;
  });
}

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function probe() {
  const s = io(SOCKET_URL, socketOptions("probe"));
  return new Promise((resolve) => {
    s.on("connect", () => {
      console.log("socket.io 连通 OK");
      s.close();
      resolve(0);
    });
    s.on("connect_error", (e) => {
      console.error("连通失败:", e.message);
      resolve(1);
    });
  });
}

async function main() {
  const cmd = process.argv[2];
  if (!TOKEN) {
    console.error("缺少 TEXHUB_TOKEN 环境变量");
    process.exit(2);
  }
  if (cmd === "probe") return probe();

  const fileId = argOf("--file");
  if (!fileId) {
    console.error('缺少 --file <fileId>（可用 GET /tex/file/tree?parent=<projectId> 查）');
    process.exit(2);
  }

  const { socket, ydoc, text, disconnect } = await connectAndSync(fileId);
  const before = text.toString();

  if (cmd === "read") {
    process.stdout.write(before);
    disconnect();
    return 0;
  }

  const localPath = argOf("--local");
  if (!localPath) {
    console.error("缺少 --local <本地文件路径>");
    disconnect();
    process.exit(2);
  }
  const incoming = readFileSync(localPath, "utf8");

  // 覆盖前先亮出现状，人工确认
  console.error(`[${fileId}] 服务端现状 ${before.length} 字符 / 本地 ${incoming.length} 字符`);
  if (before.length) {
    console.error("--- 现状前 200 字符 ---\n" + before.slice(0, 200) + "\n---");
  }

  const acked = waitAck(socket, fileId, 1).catch((e) => e);

  ydoc.transact(() => {
    if (cmd === "append") {
      text.insert(text.length, incoming);
    } else {
      text.delete(0, text.length);
      text.insert(0, incoming);
    }
  }, "ai-client");

  const result = await acked;
  disconnect();
  ydoc.destroy();

  if (result instanceof Error) {
    console.error("未确认：", result.message);
    return 1;
  }
  console.error(`[${fileId}] 服务端已确认落库 seq=${result.seq}`);
  return 0;
}

main()
  .then((c) => process.exit(c ?? 0))
  .catch((e) => {
    console.error("错误:", e.message);
    process.exit(1);
  });
