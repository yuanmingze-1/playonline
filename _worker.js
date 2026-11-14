// Cloudflare Pages + Durable Objects 实时同步后端
// 单房间（可通过 URL 参数 ?room=xxx 开多个独立房间）

function pickColor(seed){
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return `hsl(${h}, 68%, 62%)`;
}

export class Room {
  constructor(state, env){
    this.state = state;
    this.env = env;
  }

  async fetch(request){
    const url = new URL(request.url);
    if (request.headers.get("Upgrade") !== "websocket"){
      return new Response("需要 WebSocket 连接", { status: 426 });
    }

    const token = url.searchParams.get("token") || crypto.randomUUID();
    const name  = (url.searchParams.get("name") || "同学").slice(0, 16);
    const color = url.searchParams.get("color") || pickColor(token);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    server.serializeAttachment({ id: token, name, color, x: 0.5, y: 0.5 });
    this.ctx.acceptWebSocket(server, [token]);

    // 把房间内已有的其他人发给新成员
    const others = this.ctx.getWebSockets()
      .map((ws) => ws.deserializeAttachment())
      .filter((m) => m && m.id !== token);

    server.send(JSON.stringify({
      type: "init",
      you: { id: token, name, color, x: 0.5, y: 0.5 },
      players: others,
    }));

    // 通知其他人：有新成员加入
    this.broadcast(JSON.stringify({
      type: "join",
      player: { id: token, name, color, x: 0.5, y: 0.5 },
    }), token);

    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(message, excludeId){
    let sockets;
    try { sockets = this.ctx.getWebSockets(); } catch(_){ return; }
    for (const ws of sockets){
      try {
        const meta = ws.deserializeAttachment();
        if (excludeId && meta && meta.id === excludeId) continue;
        ws.send(message);
      } catch(_){ /* 忽略已断开的连接 */ }
    }
  }

  async webSocketMessage(ws, message){
    let data;
    try { data = JSON.parse(message); } catch(_){ return; }
    const meta = ws.deserializeAttachment();
    if (!meta) return;

    if (data.type === "move"){
      const x = Math.min(1, Math.max(0, Number(data.x) || 0));
      const y = Math.min(1, Math.max(0, Number(data.y) || 0));
      meta.x = x; meta.y = y;
      ws.serializeAttachment(meta);
      this.broadcast(JSON.stringify({ type: "move", id: meta.id, x, y }), null);
    } else if (data.type === "chat"){
      const text = String(data.text || "").slice(0, 500).trim();
      if (!text) return;
      this.broadcast(JSON.stringify({
        type: "chat", id: meta.id, name: meta.name, color: meta.color, text, t: Date.now(),
      }), null);
    } else if (data.type === "name"){
      const newName = String(data.name || "").slice(0, 16).trim();
      if (!newName) return;
      meta.name = newName;
      ws.serializeAttachment(meta);
      this.broadcast(JSON.stringify({ type: "name", id: meta.id, name: newName }), null);
    }
  }

  async webSocketClose(ws, code, reason){
    const meta = ws.deserializeAttachment();
    if (meta){
      this.broadcast(JSON.stringify({ type: "leave", id: meta.id, name: meta.name }), null);
    }
    try { ws.close(code, reason); } catch(_){}
  }

  async webSocketError(ws){
    try { ws.close(); } catch(_){}
  }
}

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    if (url.pathname === "/ws"){
      const room = url.searchParams.get("room") || "main";
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }
    // 其余请求交给 Pages 静态资源（index.html 等）
    return env.ASSETS.fetch(request);
  },
};
