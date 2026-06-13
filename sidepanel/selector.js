class SelectionCanvas {
  constructor(canvas, img) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.img = img;
    this.naturalWidth = img.naturalWidth;
    this.naturalHeight = img.naturalHeight;

    this.isDragging = false;
    this.startX = 0;
    this.startY = 0;
    this.rect = null; // {x, y, w, h} en coordonnées canvas

    this._handlers = {};
    this._fitCanvas();
    this._draw();
    this._bind();
  }

  // Dimensionne le canvas pour tenir dans son conteneur en respectant le ratio
  _fitCanvas() {
    const wrap = this.canvas.parentElement;
    const maxW = wrap.clientWidth > 0 ? wrap.clientWidth : 330;
    const maxH = Math.min(360, Math.floor(window.innerHeight * 0.55));

    const ratio = this.naturalWidth / this.naturalHeight;
    let w = maxW;
    let h = w / ratio;
    if (h > maxH) { h = maxH; w = h * ratio; }

    this.canvas.width = Math.round(w);
    this.canvas.height = Math.round(h);
  }

  // Convertit un événement souris/tactile en coordonnées canvas
  _getPos(e) {
    const r = this.canvas.getBoundingClientRect();
    const sx = this.canvas.width / r.width;
    const sy = this.canvas.height / r.height;
    const src = (e.touches && e.touches.length) ? e.touches[0] : e;
    return {
      x: Math.max(0, Math.min((src.clientX - r.left) * sx, this.canvas.width)),
      y: Math.max(0, Math.min((src.clientY - r.top) * sy, this.canvas.height)),
    };
  }

  _onStart(e) {
    e.preventDefault();
    const p = this._getPos(e);
    this.isDragging = true;
    this.startX = p.x;
    this.startY = p.y;
    this.rect = null;
    this._draw();
  }

  _onMove(e) {
    if (!this.isDragging) return;
    e.preventDefault();
    const p = this._getPos(e);
    this.rect = {
      x: Math.min(this.startX, p.x),
      y: Math.min(this.startY, p.y),
      w: Math.abs(p.x - this.startX),
      h: Math.abs(p.y - this.startY),
    };
    this._draw();
  }

  _onEnd(e) {
    if (!this.isDragging) return;
    this.isDragging = false;
    // Trop petit → pas de sélection
    if (this.rect && (this.rect.w < 10 || this.rect.h < 10)) {
      this.rect = null;
      this._draw();
    }
  }

  _draw() {
    const { ctx, canvas, img } = this;
    const W = canvas.width;
    const H = canvas.height;

    ctx.clearRect(0, 0, W, H);
    ctx.drawImage(img, 0, 0, W, H);

    if (!this.rect) return;

    const { x, y, w, h } = this.rect;

    // Assombrissement des 4 zones hors sélection
    ctx.fillStyle = 'rgba(0,0,0,0.52)';
    ctx.fillRect(0, 0, W, y);
    ctx.fillRect(0, y + h, W, H - y - h);
    ctx.fillRect(0, y, x, h);
    ctx.fillRect(x + w, y, W - x - w, h);

    // Bordure bleue
    ctx.strokeStyle = '#4a90e2';
    ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));

    // Poignées de coin
    const hs = 8;
    ctx.fillStyle = '#4a90e2';
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy]) => {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    });
  }

  // Retourne la sélection en coordonnées réelles (image naturelle), ou null
  getRealSelection() {
    if (!this.rect || this.rect.w < 20 || this.rect.h < 20) return null;
    const sx = this.naturalWidth / this.canvas.width;
    const sy = this.naturalHeight / this.canvas.height;
    return {
      x: Math.round(this.rect.x * sx),
      y: Math.round(this.rect.y * sy),
      w: Math.round(this.rect.w * sx),
      h: Math.round(this.rect.h * sy),
    };
  }

  hasSelection() {
    return this.rect !== null && this.rect.w >= 20 && this.rect.h >= 20;
  }

  _bind() {
    const c = this.canvas;
    const h = {
      mousedown:  e => this._onStart(e),
      mousemove:  e => this._onMove(e),
      mouseup:    e => this._onEnd(e),
      mouseleave: e => this._onEnd(e),
    };
    this._handlers = h;
    for (const [ev, fn] of Object.entries(h)) c.addEventListener(ev, fn);
    c.addEventListener('touchstart', e => this._onStart(e), { passive: false });
    c.addEventListener('touchmove',  e => this._onMove(e),  { passive: false });
    c.addEventListener('touchend',   e => this._onEnd(e));
  }

  destroy() {
    for (const [ev, fn] of Object.entries(this._handlers)) {
      this.canvas.removeEventListener(ev, fn);
    }
  }
}
