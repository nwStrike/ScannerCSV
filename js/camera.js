// Gestión de la cámara: getUserMedia, linterna y enfoque táctil con detección de capacidades.

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.caps = {};
    this.torchOn = false;
    this.deviceIds = [];
    this.deviceIndex = -1;
    // iOS exige estos atributos para reproducir en línea sin pantalla completa.
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.playsInline = true;
  }

  static isSupported() {
    return !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function');
  }

  get active() { return !!(this.track && this.track.readyState === 'live'); }

  async start(deviceId, { highRes = false } = {}) {
    this.stop();
    const video = {
      width: { ideal: highRes ? 3840 : 1920 },
      height: { ideal: highRes ? 2160 : 1080 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: 'environment' };

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      // Algunos dispositivos rechazan la resolución pedida: reintento mínimo.
      if (err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
        stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
          audio: false,
        });
      } else {
        throw err;
      }
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0] || null;
    this.torchOn = false;
    this.video.srcObject = stream;
    await new Promise((resolve) => {
      if (this.video.readyState >= 1) resolve();
      else this.video.addEventListener('loadedmetadata', resolve, { once: true });
    });
    try { await this.video.play(); } catch (err) { console.warn('video.play()', err); }
    await this._readCapabilities();
    await this._listDevices();
    return this.track;
  }

  // Más resolución para leer texto (4K si la cámara la da); 1080p para códigos (más fluido).
  async setHighRes(on) {
    if (!this.track || typeof this.track.applyConstraints !== 'function') return false;
    try {
      await this.track.applyConstraints({ width: { ideal: on ? 3840 : 1920 }, height: { ideal: on ? 2160 : 1080 } });
      return true;
    } catch (err) {
      console.warn('resolución', err);
      return false;
    }
  }

  stop() {
    if (this.stream) this.stream.getTracks().forEach((t) => { try { t.stop(); } catch { /* ignorar */ } });
    this.stream = null;
    this.track = null;
    this.caps = {};
    this.torchOn = false;
    try { this.video.pause(); } catch { /* ignorar */ }
    this.video.srcObject = null;
  }

  async _readCapabilities() {
    this.caps = {};
    const t = this.track;
    if (!t || typeof t.getCapabilities !== 'function') return; // p. ej. Safari iOS antiguo
    // En algunos Android las capacidades se rellenan un poco después de arrancar.
    for (let i = 0; i < 3; i++) {
      try { this.caps = t.getCapabilities() || {}; } catch { this.caps = {}; }
      if (Object.keys(this.caps).length > 2) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  async _listDevices() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      this.deviceIds = devs.filter((d) => d.kind === 'videoinput' && d.deviceId).map((d) => d.deviceId);
      const current = this.track && this.track.getSettings ? this.track.getSettings().deviceId : null;
      this.deviceIndex = current ? this.deviceIds.indexOf(current) : -1;
    } catch {
      this.deviceIds = [];
    }
  }

  get canSwitch() { return this.deviceIds.length > 1; }

  async switchCamera() {
    if (!this.canSwitch) return;
    const next = (this.deviceIndex + 1) % this.deviceIds.length;
    await this.start(this.deviceIds[next]);
  }

  get hasTorch() { return this.caps.torch === true || (Array.isArray(this.caps.torch) && this.caps.torch.includes(true)); }

  async setTorch(on) {
    if (!this.track || !this.hasTorch) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      this.torchOn = !!on;
      return true;
    } catch (err) {
      console.warn('torch', err);
      return false;
    }
  }

  get hasTapFocus() {
    const modes = Array.isArray(this.caps.focusMode) ? this.caps.focusMode : [];
    return modes.includes('single-shot') || ('pointsOfInterest' in this.caps);
  }

  // x, y normalizados (0..1) sobre el fotograma.
  async focusAt(x, y) {
    if (!this.track || !this.hasTapFocus) return false;
    const modes = Array.isArray(this.caps.focusMode) ? this.caps.focusMode : [];
    const c = {};
    if ('pointsOfInterest' in this.caps) c.pointsOfInterest = [{ x, y }];
    if (modes.includes('single-shot')) c.focusMode = 'single-shot';
    try {
      await this.track.applyConstraints({ advanced: [c] });
      if (modes.includes('continuous')) {
        clearTimeout(this._focusTimer);
        this._focusTimer = setTimeout(() => {
          if (this.track) this.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        }, 2500);
      }
      return true;
    } catch (err) {
      console.warn('focus', err);
      return false;
    }
  }

  // Convierte un rectángulo en pantalla (p. ej. el marco) a coordenadas del vídeo,
  // teniendo en cuenta object-fit: cover.
  screenRectToVideo(rect) {
    const v = this.video;
    const vw = v.videoWidth, vh = v.videoHeight;
    const box = v.getBoundingClientRect();
    if (!vw || !vh || !box.width) return { x: 0, y: 0, w: vw, h: vh };
    const scale = Math.max(box.width / vw, box.height / vh);
    const ox = (box.width - vw * scale) / 2;
    const oy = (box.height - vh * scale) / 2;
    let x = (rect.left - box.left - ox) / scale;
    let y = (rect.top - box.top - oy) / scale;
    let w = rect.width / scale;
    let h = rect.height / scale;
    x = Math.max(0, Math.min(vw, x)); y = Math.max(0, Math.min(vh, y));
    w = Math.max(1, Math.min(vw - x, w)); h = Math.max(1, Math.min(vh - y, h));
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
  }

  screenPointToVideoNorm(clientX, clientY) {
    const r = this.screenRectToVideo({ left: clientX, top: clientY, width: 1, height: 1 });
    return { x: r.x / (this.video.videoWidth || 1), y: r.y / (this.video.videoHeight || 1) };
  }

  // Copia una región del vídeo a un canvas, reducida a maxSide px de lado largo.
  grab(region, maxSide, canvas) {
    const v = this.video;
    const r = region || { x: 0, y: 0, w: v.videoWidth, h: v.videoHeight };
    const scale = Math.min(1, maxSide / Math.max(r.w, r.h));
    const w = Math.max(1, Math.round(r.w * scale));
    const h = Math.max(1, Math.round(r.h * scale));
    const c = canvas || document.createElement('canvas');
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(v, r.x, r.y, r.w, r.h, 0, 0, w, h);
    return c;
  }
}
