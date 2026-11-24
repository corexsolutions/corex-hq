/* CoreX HQ — Gemini Live voice calls (browser side).
   The API key never reaches the page: n8n mints a single-use token that is
   locked to one employee's persona, voice and tools. */
(function () {
  const WS = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
  // Mic worklet: PCM16 chunks of ~100 ms with a noise gate. The gate learns the
  // room's background level and only lets through sound clearly louder than it
  // (the close voice of the person holding the phone), so a noisy room or people
  // talking further away are sent as silence.
  const WORKLET = "class P extends AudioWorkletProcessor{constructor(o){super();const q=(o&&o.processorOptions)||{};this.b=new Int16Array(q.n||1600);this.n=0;this.on=true;this.fl=0.008;this.h=0;this.ss=0;this.port.onmessage=e=>{this.on=e.data}}" +
    "process(i){const c=i[0]&&i[0][0];if(!c)return true;for(let k=0;k<c.length;k++){const s=Math.max(-1,Math.min(1,c[k]));this.ss+=s*s;this.b[this.n++]=s*32767;if(this.n===this.b.length){const r=Math.sqrt(this.ss/this.n);this.ss=0;" +
    "if(r<this.fl*1.5)this.fl=this.fl*0.85+r*0.15;else this.fl=this.fl*0.998+r*0.002;const open=r>Math.max(0.004,this.fl*1.7);if(open)this.h=10;else if(this.h>0)this.h--;" +
    "if(!this.on||this.h===0)this.b.fill(0);this.port.postMessage(this.b.slice(0));this.n=0}}return true}}registerProcessor('cx-pcm16',P)";
  let inCtx = null, outCtx = null, og = null;
  // Employees play softer and warmer: lower level, highs (sibilance/harshness) cut,
  // a little body in the low-mids, and a gentle compressor so no word jumps out loud.
  const OUT_VOL = 0.36;
  function outGain() {
    if (og && og.context === outCtx) return og;
    const c = outCtx;
    og = c.createGain(); og.gain.value = OUT_VOL;
    const hp = c.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 90;          // rumble / hum
    const warm = c.createBiquadFilter(); warm.type = "lowshelf"; warm.frequency.value = 260; warm.gain.value = 2.5;
    const soft = c.createBiquadFilter(); soft.type = "highshelf"; soft.frequency.value = 2800; soft.gain.value = -9;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 5500; lp.Q.value = 0.5;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -26; comp.knee.value = 18; comp.ratio.value = 3.5; comp.attack.value = 0.01; comp.release.value = 0.25;
    og.connect(hp); hp.connect(warm); warm.connect(soft); soft.connect(lp); lp.connect(comp); comp.connect(c.destination);
    return og;
  }

  function b64(buf) { const u = new Uint8Array(buf); let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
  function unb64(s) { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }

  // Must run inside the click handler so iOS/Safari allow audio.
  function prepare() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!inCtx || inCtx.state === "closed") inCtx = new AC();
    // Default device rate: forcing 24 kHz makes some phones crackle; buffers stay 24 kHz and get resampled cleanly.
    if (!outCtx || outCtx.state === "closed") outCtx = new AC();
    inCtx.resume().catch(() => {}); outCtx.resume().catch(() => {});
    return true;
  }

  async function start(o) {
    // o: {token, model, kick, onOpen, onClose(reason), onMode('speaking'|'listening'), onText(role,chunk), onTurn(), onTool(name,args)->Promise<string>}
    if (!inCtx || !outCtx) prepare();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    if (inCtx._cx !== 2) { await inCtx.audioWorklet.addModule(url); inCtx._cx = 2; }
    const src = inCtx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(inCtx, "cx-pcm16", { processorOptions: { n: Math.round(inCtx.sampleRate / 10) } });
    const sink = inCtx.createGain(); sink.gain.value = 0;
    const boost = inCtx.createGain(); boost.gain.value = 2.2; src.connect(boost); boost.connect(node); node.connect(sink); sink.connect(inCtx.destination);
    const rate = inCtx.sampleRate;

    let idleT = 0, ready = false, closed = false, playHead = 0, playing = [], speaking = false, lastRole = null;
    const ws = new WebSocket(WS + "?access_token=" + encodeURIComponent(o.token));
    const send = m => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };

    function setSpeaking(v) { if (v !== speaking) { speaking = v; o.onMode && o.onMode(v ? "speaking" : "listening"); } }
    function stopAudio() { clearTimeout(idleT); playing.forEach(s => { try { s.stop(); } catch (e) {} }); playing = []; playHead = 0; setSpeaking(false); }
    function play(pcm) {
      const n = pcm.length >> 1, f = new Float32Array(n), dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
      // A new sentence after silence: fade in over 40 ms and start a bit later so there is no click/pop at the start.
      const fresh = playHead <= outCtx.currentTime + 0.01;
      if (fresh) { const fi = Math.min(n, 960); for (let i = 0; i < fi; i++) f[i] *= i / fi; }
      const buf = outCtx.createBuffer(1, n, 24000); buf.copyToChannel(f, 0);
      const s = outCtx.createBufferSource(); s.buffer = buf; s.connect(outGain());
      // Keep ~250 ms of audio queued so late network chunks never leave gaps (gaps = crackle).
      const t = Math.max(outCtx.currentTime + (fresh ? 0.25 : 0.12), playHead); s.start(t); playHead = t + buf.duration;
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
