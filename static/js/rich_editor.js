/* CBT System — rich question editor.
 * Adds a formatting toolbar + live preview to a <textarea> (stem, explanation,
 * model answer), or a compact LaTeX/image toolbar to a single-line <input>
 * (answer choices). Handles equations (LaTeX rendered via KaTeX), image
 * upload, freehand diagram drawing, and function/data graph plotting — all
 * inserted as sanitized HTML the exam-taking screen already knows how to
 * render (it sets stem/choice text via innerHTML).
 */
(function () {
  "use strict";

  const LATEX_SNIPPETS = [
    { label: "x²", insert: "$x^2$" },
    { label: "xₙ", insert: "$x_n$" },
    { label: "a⁄b", insert: "$\\frac{a}{b}$" },
    { label: "√x", insert: "$\\sqrt{x}$" },
    { label: "ⁿ√x", insert: "$\\sqrt[n]{x}$" },
    { label: "∑", insert: "$\\sum_{i=1}^{n}$" },
    { label: "∫", insert: "$\\int_{a}^{b}$" },
    { label: "π", insert: "$\\pi$" },
    { label: "θ", insert: "$\\theta$" },
    { label: "Δ", insert: "$\\Delta$" },
    { label: "α β", insert: "$\\alpha \\beta$" },
    { label: "±", insert: "$\\pm$" },
    { label: "≤ ≥", insert: "$\\leq \\geq$" },
    { label: "≠", insert: "$\\neq$" },
    { label: "→", insert: "$\\rightarrow$" },
    { label: "∞", insert: "$\\infty$" },
    { label: "matrix", insert: "$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$" },
  ];

  let uploadUrl = "/staff/upload-asset/";
  let csrfToken = "";

  function config(opts) {
    if (opts.uploadUrl) uploadUrl = opts.uploadUrl;
    if (opts.csrfToken) csrfToken = opts.csrfToken;
  }

  function renderMathIn(el) {
    if (window.renderMathInElement) {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true }, { left: "$", right: "$", display: false },
          { left: "\\[", right: "\\]", display: true }, { left: "\\(", right: "\\)", display: false },
        ],
        throwOnError: false,
      });
    }
  }

  function insertAtCursor(field, text) {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? field.value.length;
    field.value = field.value.slice(0, start) + text + field.value.slice(end);
    const pos = start + text.length;
    field.focus();
    field.setSelectionRange(pos, pos);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function wrapSelection(field, before, after) {
    const start = field.selectionStart ?? 0;
    const end = field.selectionEnd ?? 0;
    const selected = field.value.slice(start, end) || "text";
    const text = before + selected + after;
    field.value = field.value.slice(0, start) + text + field.value.slice(end);
    field.focus();
    field.setSelectionRange(start + before.length, start + before.length + selected.length);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function uploadImage(fileOrDataUrl, onDone, onError) {
    const body = new FormData();
    if (typeof fileOrDataUrl === "string") {
      body.append("data_url", fileOrDataUrl);
    } else {
      body.append("file", fileOrDataUrl);
    }
    fetch(uploadUrl, { method: "POST", body, headers: { "X-CSRFToken": csrfToken } })
      .then((r) => r.json())
      .then((d) => { if (d.url) onDone(d.url); else onError(d.error || "Upload failed"); })
      .catch(() => onError("Network error during upload"));
  }

  function makeBtn(label, title, onClick, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "rte-btn" + (cls ? " " + cls : "");
    b.textContent = label;
    b.title = title || label;
    b.onclick = onClick;
    return b;
  }

  // ─────────────────────────────────────── DIAGRAM MODAL ──

  function openDiagramModal(onInsert) {
    const overlay = document.createElement("div");
    overlay.className = "rte-overlay";
    overlay.innerHTML = `
      <div class="rte-modal rte-modal-wide">
        <div class="rte-modal-head">Draw Diagram <button type="button" class="rte-x">&times;</button></div>
        <div class="rte-diagram-toolbar">
          <button type="button" data-tool="pen" class="rte-tool active">✏ Pen</button>
          <button type="button" data-tool="line" class="rte-tool">／ Line</button>
          <button type="button" data-tool="rect" class="rte-tool">▭ Rect</button>
          <button type="button" data-tool="ellipse" class="rte-tool">◯ Ellipse</button>
          <button type="button" data-tool="arrow" class="rte-tool">→ Arrow</button>
          <button type="button" data-tool="text" class="rte-tool">T Text</button>
          <button type="button" data-tool="eraser" class="rte-tool">⌫ Eraser</button>
          <input type="color" class="rte-color" value="#111827">
          <input type="range" class="rte-width" min="1" max="14" value="3" title="Stroke width">
          <button type="button" class="rte-undo">Undo</button>
          <button type="button" class="rte-clear">Clear</button>
        </div>
        <canvas class="rte-canvas" width="760" height="440"></canvas>
        <div class="rte-modal-actions">
          <button type="button" class="btn btn-outline rte-cancel">Cancel</button>
          <button type="button" class="btn btn-primary rte-insert">Insert Diagram</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector(".rte-canvas");
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    let tool = "pen";
    let drawing = false;
    let startX = 0, startY = 0;
    let snapshot = null;
    const undoStack = [];

    function pushUndo() {
      undoStack.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (undoStack.length > 30) undoStack.shift();
    }
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const cx = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
      const cy = (e.touches ? e.touches[0].clientY : e.clientY) - r.top;
      return [cx * (canvas.width / r.width), cy * (canvas.height / r.height)];
    }
    function drawArrowHead(x1, y1, x2, y2, color, width) {
      const angle = Math.atan2(y2 - y1, x2 - x1);
      const len = 10 + width;
      ctx.beginPath();
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(angle - Math.PI / 6), y2 - len * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(x2, y2);
      ctx.lineTo(x2 - len * Math.cos(angle + Math.PI / 6), y2 - len * Math.sin(angle + Math.PI / 6));
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.stroke();
    }

    overlay.querySelectorAll(".rte-tool").forEach((btn) => {
      btn.onclick = () => {
        overlay.querySelectorAll(".rte-tool").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        tool = btn.dataset.tool;
      };
    });

    canvas.addEventListener("pointerdown", (e) => {
      drawing = true;
      [startX, startY] = pos(e);
      const color = overlay.querySelector(".rte-color").value;
      const width = parseInt(overlay.querySelector(".rte-width").value, 10);
      if (tool === "text") {
        const label = prompt("Text to place on diagram:");
        drawing = false;
        if (label) {
          pushUndo();
          ctx.fillStyle = color;
          ctx.font = `${12 + width * 2}px sans-serif`;
          ctx.fillText(label, startX, startY);
        }
        return;
      }
      if (tool === "pen" || tool === "eraser") {
        pushUndo();
        ctx.strokeStyle = tool === "eraser" ? "#ffffff" : color;
        ctx.lineWidth = tool === "eraser" ? width * 4 : width;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(startX, startY);
      } else {
        snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
      }
    });

    canvas.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      const [x, y] = pos(e);
      const color = overlay.querySelector(".rte-color").value;
      const width = parseInt(overlay.querySelector(".rte-width").value, 10);
      if (tool === "pen" || tool === "eraser") {
        ctx.lineTo(x, y);
        ctx.stroke();
        return;
      }
      ctx.putImageData(snapshot, 0, 0);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (tool === "line" || tool === "arrow") {
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(x, y);
        ctx.stroke();
        if (tool === "arrow") drawArrowHead(startX, startY, x, y, color, width);
      } else if (tool === "rect") {
        ctx.strokeRect(startX, startY, x - startX, y - startY);
      } else if (tool === "ellipse") {
        ctx.beginPath();
        ctx.ellipse((startX + x) / 2, (startY + y) / 2, Math.abs(x - startX) / 2, Math.abs(y - startY) / 2, 0, 0, 2 * Math.PI);
        ctx.stroke();
      }
    });

    function endDraw() {
      if (!drawing) return;
      drawing = false;
      if (tool !== "pen" && tool !== "eraser") pushUndo();
    }
    canvas.addEventListener("pointerup", endDraw);
    canvas.addEventListener("pointerleave", endDraw);

    overlay.querySelector(".rte-undo").onclick = () => {
      if (undoStack.length) ctx.putImageData(undoStack.pop(), 0, 0);
    };
    overlay.querySelector(".rte-clear").onclick = () => {
      pushUndo();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    };
    overlay.querySelector(".rte-x").onclick = () => overlay.remove();
    overlay.querySelector(".rte-cancel").onclick = () => overlay.remove();
    overlay.querySelector(".rte-insert").onclick = () => {
      const btn = overlay.querySelector(".rte-insert");
      btn.disabled = true;
      btn.textContent = "Uploading…";
      uploadImage(canvas.toDataURL("image/png"), (url) => { overlay.remove(); onInsert(url); },
        (err) => { alert(err); btn.disabled = false; btn.textContent = "Insert Diagram"; });
    };
  }

  // ─────────────────────────────────────── GRAPH MODAL ──

  function safeEvalExpr(expr, xVal) {
    const fn = expr
      .replace(/\^/g, "**")
      .replace(/\bsin\b/g, "Math.sin").replace(/\bcos\b/g, "Math.cos").replace(/\btan\b/g, "Math.tan")
      .replace(/\bsqrt\b/g, "Math.sqrt").replace(/\babs\b/g, "Math.abs").replace(/\blog\b/g, "Math.log10")
      .replace(/\bln\b/g, "Math.log").replace(/\bpi\b/g, "Math.PI").replace(/\be\b/g, "Math.E");
    try {
      // eslint-disable-next-line no-new-func
      return Function("x", `"use strict"; return (${fn});`)(xVal);
    } catch (e) {
      return NaN;
    }
  }

  function drawAxes(ctx, w, h, pad) {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#d1d5db";
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, w - 2 * pad, h - 2 * pad);
  }

  function openGraphModal(onInsert) {
    const overlay = document.createElement("div");
    overlay.className = "rte-overlay";
    overlay.innerHTML = `
      <div class="rte-modal rte-modal-wide">
        <div class="rte-modal-head">Insert Graph <button type="button" class="rte-x">&times;</button></div>
        <div class="rte-graph-tabs">
          <button type="button" class="rte-gtab active" data-tab="fn">Function y = f(x)</button>
          <button type="button" class="rte-gtab" data-tab="data">Data Chart</button>
        </div>
        <div class="rte-gpanel" data-panel="fn">
          <div class="rte-grow">
            <label>f(x) =</label><input type="text" class="rte-fn-expr form-input" value="x^2" placeholder="e.g. sin(x), x^2 - 3*x + 2">
            <label>x min</label><input type="number" class="rte-fn-min form-input" value="-10" style="width:80px">
            <label>x max</label><input type="number" class="rte-fn-max form-input" value="10" style="width:80px">
            <button type="button" class="btn btn-outline rte-fn-plot">Plot</button>
          </div>
        </div>
        <div class="rte-gpanel" data-panel="data" style="display:none">
          <div class="rte-grow" style="align-items:flex-start">
            <select class="rte-chart-type form-select" style="width:120px"><option value="bar">Bar</option><option value="line">Line</option></select>
            <div class="rte-data-rows"></div>
          </div>
          <button type="button" class="btn btn-outline rte-add-row">+ Row</button>
          <button type="button" class="btn btn-outline rte-data-plot">Plot</button>
        </div>
        <canvas class="rte-canvas" width="760" height="420"></canvas>
        <div class="rte-modal-actions">
          <button type="button" class="btn btn-outline rte-cancel">Cancel</button>
          <button type="button" class="btn btn-primary rte-insert">Insert Graph</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const canvas = overlay.querySelector(".rte-canvas");
    const ctx = canvas.getContext("2d");
    drawAxes(ctx, canvas.width, canvas.height, 40);

    overlay.querySelectorAll(".rte-gtab").forEach((tab) => {
      tab.onclick = () => {
        overlay.querySelectorAll(".rte-gtab").forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        overlay.querySelectorAll(".rte-gpanel").forEach((p) => { p.style.display = p.dataset.panel === tab.dataset.tab ? "" : "none"; });
      };
    });

    function plotFunction() {
      const expr = overlay.querySelector(".rte-fn-expr").value.trim() || "x";
      const xMin = parseFloat(overlay.querySelector(".rte-fn-min").value) || -10;
      const xMax = parseFloat(overlay.querySelector(".rte-fn-max").value) || 10;
      const w = canvas.width, h = canvas.height, pad = 40;
      drawAxes(ctx, w, h, pad);

      const samples = [];
      let yMin = Infinity, yMax = -Infinity;
      const steps = 400;
      for (let i = 0; i <= steps; i++) {
        const x = xMin + ((xMax - xMin) * i) / steps;
        const y = safeEvalExpr(expr, x);
        samples.push([x, y]);
        if (isFinite(y)) { yMin = Math.min(yMin, y); yMax = Math.max(yMax, y); }
      }
      if (!isFinite(yMin) || !isFinite(yMax)) { yMin = -1; yMax = 1; }
      if (yMin === yMax) { yMin -= 1; yMax += 1; }
      const yPad = (yMax - yMin) * 0.1;
      yMin -= yPad; yMax += yPad;

      const toPx = (x, y) => [
        pad + ((x - xMin) / (xMax - xMin)) * (w - 2 * pad),
        h - pad - ((y - yMin) / (yMax - yMin)) * (h - 2 * pad),
      ];

      // gridlines + zero axes
      ctx.strokeStyle = "#f3f4f6"; ctx.lineWidth = 1;
      for (let gx = Math.ceil(xMin); gx <= xMax; gx++) {
        const [px] = toPx(gx, 0);
        ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, h - pad); ctx.stroke();
      }
      if (xMin <= 0 && xMax >= 0) {
        const [px] = toPx(0, 0);
        ctx.strokeStyle = "#9ca3af"; ctx.beginPath(); ctx.moveTo(px, pad); ctx.lineTo(px, h - pad); ctx.stroke();
      }
      if (yMin <= 0 && yMax >= 0) {
        const [, py] = toPx(0, 0);
        ctx.strokeStyle = "#9ca3af"; ctx.beginPath(); ctx.moveTo(pad, py); ctx.lineTo(w - pad, py); ctx.stroke();
      }

      ctx.strokeStyle = "#e11d48"; ctx.lineWidth = 2.5;
      ctx.beginPath();
      let started = false;
      samples.forEach(([x, y]) => {
        if (!isFinite(y)) { started = false; return; }
        const [px, py] = toPx(x, y);
        if (!started) { ctx.moveTo(px, py); started = true; } else { ctx.lineTo(px, py); }
      });
      ctx.stroke();

      ctx.fillStyle = "#6b7280"; ctx.font = "11px sans-serif";
      ctx.fillText(xMin.toFixed(1), pad, h - pad + 14);
      ctx.fillText(xMax.toFixed(1), w - pad - 24, h - pad + 14);
      ctx.fillText(yMax.toFixed(1), 4, pad + 4);
      ctx.fillText(yMin.toFixed(1), 4, h - pad);
      ctx.fillText(`y = ${expr}`, pad, 16);
    }

    const rowsWrap = overlay.querySelector(".rte-data-rows");
    function addRow(label, value) {
      const row = document.createElement("div");
      row.className = "rte-data-row";
      row.innerHTML = `<input type="text" class="form-input rte-d-label" placeholder="Label" value="${label || ""}"><input type="number" class="form-input rte-d-value" placeholder="Value" value="${value ?? ""}"><button type="button" class="rte-btn rte-d-remove">✕</button>`;
      row.querySelector(".rte-d-remove").onclick = () => row.remove();
      rowsWrap.appendChild(row);
    }
    addRow("A", 10); addRow("B", 20); addRow("C", 15);
    overlay.querySelector(".rte-add-row").onclick = () => addRow("", "");

    function plotData() {
      const chartType = overlay.querySelector(".rte-chart-type").value;
      const rows = [...rowsWrap.querySelectorAll(".rte-data-row")].map((r) => ({
        label: r.querySelector(".rte-d-label").value || "",
        value: parseFloat(r.querySelector(".rte-d-value").value) || 0,
      })).filter((r) => r.label);
      const w = canvas.width, h = canvas.height, pad = 40;
      drawAxes(ctx, w, h, pad);
      if (!rows.length) return;
      const maxVal = Math.max(...rows.map((r) => r.value), 1);
      const plotW = w - 2 * pad, plotH = h - 2 * pad;
      const n = rows.length;
      const slot = plotW / n;

      ctx.strokeStyle = "#9ca3af"; ctx.beginPath(); ctx.moveTo(pad, h - pad); ctx.lineTo(w - pad, h - pad); ctx.stroke();

      if (chartType === "bar") {
        rows.forEach((r, i) => {
          const barW = slot * 0.6;
          const barH = (r.value / maxVal) * plotH;
          const x = pad + i * slot + (slot - barW) / 2;
          const y = h - pad - barH;
          ctx.fillStyle = "#5b5ef4";
          ctx.fillRect(x, y, barW, barH);
          ctx.fillStyle = "#111827"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
          ctx.fillText(r.label, x + barW / 2, h - pad + 14);
          ctx.fillText(String(r.value), x + barW / 2, y - 4);
        });
      } else {
        ctx.strokeStyle = "#e11d48"; ctx.lineWidth = 2.5; ctx.beginPath();
        rows.forEach((r, i) => {
          const x = pad + i * slot + slot / 2;
          const y = h - pad - (r.value / maxVal) * plotH;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        });
        ctx.stroke();
        ctx.fillStyle = "#111827"; ctx.font = "10px sans-serif"; ctx.textAlign = "center";
        rows.forEach((r, i) => {
          const x = pad + i * slot + slot / 2;
          const y = h - pad - (r.value / maxVal) * plotH;
          ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fillStyle = "#e11d48"; ctx.fill();
          ctx.fillStyle = "#111827";
          ctx.fillText(r.label, x, h - pad + 14);
        });
      }
      ctx.textAlign = "left";
    }

    overlay.querySelector(".rte-fn-plot").onclick = plotFunction;
    overlay.querySelector(".rte-data-plot").onclick = plotData;
    overlay.querySelector(".rte-x").onclick = () => overlay.remove();
    overlay.querySelector(".rte-cancel").onclick = () => overlay.remove();
    overlay.querySelector(".rte-insert").onclick = () => {
      const activeTab = overlay.querySelector(".rte-gtab.active").dataset.tab;
      if (activeTab === "fn") plotFunction(); else plotData();
      const btn = overlay.querySelector(".rte-insert");
      btn.disabled = true;
      btn.textContent = "Uploading…";
      uploadImage(canvas.toDataURL("image/png"), (url) => { overlay.remove(); onInsert(url); },
        (err) => { alert(err); btn.disabled = false; btn.textContent = "Insert Graph"; });
    };
    plotFunction();
  }

  // ─────────────────────────────────────── PUBLIC ATTACH ──

  function attachField(textarea, opts) {
    opts = opts || {};
    const wrap = document.createElement("div");
    wrap.className = "rte-wrap";
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(textarea);
    textarea.classList.add("rte-source");

    const toolbar = document.createElement("div");
    toolbar.className = "rte-toolbar";
    wrap.insertBefore(toolbar, textarea);

    toolbar.appendChild(makeBtn("B", "Bold", () => wrapSelection(textarea, "<b>", "</b>"), "rte-b"));
    toolbar.appendChild(makeBtn("I", "Italic", () => wrapSelection(textarea, "<i>", "</i>"), "rte-i"));
    toolbar.appendChild(makeBtn("x²", "Superscript", () => wrapSelection(textarea, "<sup>", "</sup>")));
    toolbar.appendChild(makeBtn("x₂", "Subscript", () => wrapSelection(textarea, "<sub>", "</sub>")));

    const symWrap = document.createElement("span");
    symWrap.className = "rte-sym-group";
    LATEX_SNIPPETS.forEach((s) => {
      symWrap.appendChild(makeBtn(s.label, "Insert " + s.insert, () => insertAtCursor(textarea, s.insert), "rte-sym"));
    });
    toolbar.appendChild(symWrap);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.onchange = () => {
      if (!fileInput.files.length) return;
      const btn = toolbar.querySelector(".rte-img-btn");
      btn.disabled = true; btn.textContent = "Uploading…";
      uploadImage(fileInput.files[0], (url) => {
        insertAtCursor(textarea, `<img src="${url}" style="max-width:100%">`);
        btn.disabled = false; btn.textContent = "🖼 Image";
        fileInput.value = "";
      }, (err) => { alert(err); btn.disabled = false; btn.textContent = "🖼 Image"; });
    };
    toolbar.appendChild(fileInput);
    toolbar.appendChild(makeBtn("🖼 Image", "Upload an image", () => fileInput.click(), "rte-img-btn"));

    if (opts.diagrams !== false) {
      toolbar.appendChild(makeBtn("✏ Diagram", "Draw a diagram", () => {
        openDiagramModal((url) => insertAtCursor(textarea, `<img src="${url}" style="max-width:100%">`));
      }));
      toolbar.appendChild(makeBtn("📈 Graph", "Insert a function or data graph", () => {
        openGraphModal((url) => insertAtCursor(textarea, `<img src="${url}" style="max-width:100%">`));
      }));
    }

    const preview = document.createElement("div");
    preview.className = "rte-preview";
    wrap.appendChild(preview);

    let debounce;
    function refreshPreview() {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        preview.innerHTML = textarea.value.trim() ? textarea.value : "<span class='rte-preview-empty'>Live preview appears here…</span>";
        renderMathIn(preview);
      }, 200);
    }
    textarea.addEventListener("input", refreshPreview);
    refreshPreview();
  }

  function attachCompactField(input, opts) {
    opts = opts || {};
    const wrap = document.createElement("span");
    wrap.className = "rte-compact-wrap";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const toolbar = document.createElement("span");
    toolbar.className = "rte-compact-toolbar";
    wrap.appendChild(toolbar);

    const dropdown = document.createElement("select");
    dropdown.className = "rte-compact-sym";
    dropdown.innerHTML = '<option value="">∑ LaTeX…</option>' + LATEX_SNIPPETS.map((s) => `<option value="${encodeURIComponent(s.insert)}">${s.label}</option>`).join("");
    dropdown.onchange = () => {
      if (dropdown.value) insertAtCursor(input, decodeURIComponent(dropdown.value));
      dropdown.value = "";
    };
    toolbar.appendChild(dropdown);

    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    fileInput.onchange = () => {
      if (!fileInput.files.length) return;
      uploadImage(fileInput.files[0], (url) => {
        insertAtCursor(input, `<img src="${url}" style="max-width:100%">`);
        fileInput.value = "";
      }, (err) => alert(err));
    };
    toolbar.appendChild(fileInput);
    toolbar.appendChild(makeBtn("🖼", "Insert image", () => fileInput.click()));

    const preview = document.createElement("div");
    preview.className = "rte-compact-preview";
    wrap.appendChild(preview);
    let debounce;
    function refreshPreview() {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        preview.innerHTML = input.value;
        renderMathIn(preview);
      }, 200);
    }
    input.addEventListener("input", refreshPreview);
    refreshPreview();
  }

  window.CBTRichEditor = { config, attachField, attachCompactField };
})();
