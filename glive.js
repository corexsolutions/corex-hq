/* CoreX HQ — Gemini Live voice calls (browser side).
   The API key never reaches the page: n8n mints a single-use token that is
   locked to one employee's persona, voice and tools. */
(function () {
  const WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
  const WORKLET = "class P extends AudioWorkletProcessor{constructor(o){super();this.b=new Int16Array((o&&o.processorOptions&&o.processorOptions.n)||1600);this.n=0;this.on=true;this.port.onmessage=e=>{this.on=e.data}}" +
    "process(i){const c=i[0]&&i[0][0];if(!c)return true;for(let k=0;k<c.length;k++){const s=Math.max(-1,Math.min(1,c[k]));this.b[this.n++]=this.on?s*32767:0;if(this.n===this.b.length){this.port.postMessage(this.b.slice(0));this.n=0}}return true}}registerProcessor('cx-pcm16',P)";
  let inCtx = null, outCtx = null;

  function b64(buf) { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

  // Must run inside the click handler so iOS/Safari allow audio.
  function prepare() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!inCtx || inCtx.state === "closed") inCtx = new AC();
    try { if (!outCtx || outCtx.state === "closed") outCtx = new AC({ sampleRate: 24000 }); } catch (e) { outCtx = new AC(); }
    inCtx.resume().catch(() => {}); outCtx.resume().catch(() => {});
    return true;
  }

  async function start(o) {
    // o: {token, model, kick, onOpen, onClose(reason), onMode('speaking'|'listening'), onText(role,chunk), onTurn(), onTool(name,args)->Promise<string>}
    if (!inCtx || !outCtx) prepare();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    if (!inCtx._cx) { await inCtx.audioWorklet.addModule(url); inCtx._cx = 1; }
    const src = inCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(inCtx, "cx-pcm16", { processorOptions: { n: Math.round(inCtx.sampleRate / 10) } });
    const sink = inCtx.createGain(); sink.gain.value = 0;
    src.connect(node); node.connect(sink); sink.connect(inCtx.destination);
    const rate = inCtx.sampleRate;

    let idleT = 0, ready = false, closed = false, playHead = 0, playing = [], speaking = false, lastRole = null;
    const ws = new WebSocket(WS + "?access_token=" + encodeURIComponent(o.token));
    const send = m => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };

    function setSpeaking(v) { if (v !== speaking) { speaking = v; o.onMode && o.onMode(v ? "speaking" : "listening"); } }
    function stopAudio() { clearTimeout(idleT); playing.forEach(s => { try { s.stop(); } catch (e) {} }); playing = []; playHead = 0; setSpeaking(false); }
    function play(pcm) {
      const n = pcm.length >> 1, f = new Float32Array(n), dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
      const buf = outCtx.createBuffer(1, n, 24000); buf.copyToChannel(f, 0);
      const s = outCtx.createBufferSource(); s.buffer = buf; s.connect(outCtx.destination);
      const t = Math.max(outCtx.currentTime + 0.03, playHead); s.start(t); playHead = t + buf.duration;
      playing.push(s); setSpeaking(true);
      clearTimeout(idleT); idleT = setTimeout(function chk() { const left = playHead - outCtx.currentTime; if (left > 0.05) idleT = setTimeout(chk, left * 1000 + 60); else { playing = []; setSpeaking(false); } }, (playHead - outCtx.currentTime) * 1000 + 60);
      s.onended = () => { playing = playing.filter(x => x !== s); if (!playing.length && outCtx.currentTime >= playHead - 0.05) setSpeaking(false); };
    }
    function text(role, chunk) { if (!chunk) return; if (lastRole && lastRole !== role) o.onTurn && o.onTurn(); lastRole = role; o.onText && o.onText(role, chunk); }

    // Echo guard: speakers leak the employee's own voice into the mic and the model
    // takes it as the user talking and stops. While the employee speaks (plus a short
    // tail for room echo) the mic is not sent.
    const TAIL = 0.45;
    const echoing = () => speaking || playing.length > 0 || outCtx.currentTime < playHead + TAIL;
    node.port.onmessage = e => { if (ready && !echoing()) send({ realtimeInput: { audio: { data: b64(e.data.buffer), mimeType: "audio/pcm;rate=" + rate } } }); };

    ws.onopen = () => send({ setup: { model: o.model } });
    ws.onmessage = async ev => {
      let m; try { m = JSON.parse(typeof ev.data === "string" ? ev.data : await ev.data.text()); } catch (e) { return; }
      if (m.setupComplete) {
        ready = true; o.onOpen && o.onOpen();
        if (o.kick) send({ clientContent: { turns: [{ role: "user", parts: [{ text: o.kick }] }], turnComplete: true } });
        return;
      }
      const sc = m.serverContent;
      if (sc) {
        if (sc.interrupted) stopAudio();
        if (sc.inputTranscription) text("u", sc.inputTranscription.text);
        if (sc.outputTranscription) text("a", sc.outputTranscription.text);
        const parts = (sc.modelTurn && sc.modelTurn.parts) || [];
        for (const p of parts) if (p.inlineData && /audio/.test(p.inlineData.mimeType || "")) play(unb64(p.inlineData.data));
        if (sc.turnComplete) { o.onTurn && o.onTurn(); lastRole = null; }
      }
      if (m.toolCall && m.toolCall.functionCalls) {
        const res = [];
        for (const fc of m.toolCall.functionCalls) {
          let out = "تمام";
          try { out = o.onTool ? await o.onTool(fc.name, fc.args || {}) : "مش متاح"; } catch (e) { out = "التسجيل ما نجحش: " + (e && e.message || e); }
          res.push({ id: fc.id, name: fc.name, response: { result: out } });
        }
        send({ toolResponse: { functionResponses: res } });
      }
      if (m.goAway) console.log("GLive goAway", m.goAway);
    };
    ws.onerror = e => console.log("GLive ws error", e);
    ws.onclose = ev => { if (closed) return; finish(ev.reason || ("closed " + ev.code), ready); };

    function finish(reason, wasReady) {
      closed = true; ready = false; stopAudio();
      try { node.port.onmessage = null; src.disconnect(); node.disconnect(); } catch (e) {}
      stream.getTracks().forEach(t => t.stop());
      try { if (ws.readyState < 2) ws.close(); } catch (e) {}
      o.onClose && o.onClose(reason, wasReady);
    }

    return {
      end() { if (!closed) finish("ended", true); },
      mute(v) { node.port.postMessage(!v); },
      get open() { return !closed; }
    };
  }

  window.GLive = { prepare, start };
})();
