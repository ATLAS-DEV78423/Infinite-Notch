// Dev harness: plays the whole drop sequence in a plain browser so the
// choreography can be watched without an OLE drag. Not part of the app bundle.

import { UploadCanvas } from "../src/upload/canvas";
import { UploadSeq } from "../src/upload/sequence";
import { State } from "../src/core/state";

State.filePreparation.begin("preview", "rapport-q3.pdf");

const stage = document.getElementById("stage")!;
const clock = document.getElementById("clock")!;
const ready = document.createElement("button");
ready.textContent = "Resolve synthetic preparation (no native I/O)";
ready.onclick = () => {
  if (!UploadSeq.dropped) return;
  State.filePreparation.complete("preview", { name: "rapport-q3.pdf", path: "/synthetic-preview/rapport-q3.pdf", size: 0 });
  UploadSeq.finishPreparation(true);
};
clock.after(ready);

const canvas = new UploadCanvas({
  ask: () => (clock.textContent = "ASK clicked"),
  cancel: () => (clock.textContent = "CANCEL clicked"),
});
canvas.el.classList.add("on");
canvas.el.style.position = "absolute";
canvas.el.style.left = "0";
stage.append(canvas.el);

// The cursor walks in from the right, settles over the box, then drops.
// The whole thing restarts every 12 s so it can be watched (and screenshotted)
// without reloading the page.
const CYCLE = 12;
let start = performance.now();
let dropped = false;
UploadSeq.enterZone(520, 96);

function loop(now: number) {
  let t = (now - start) / 1000;
  if (t >= CYCLE) {
    start = now;
    t = 0;
    dropped = false;
    State.filePreparation.begin("preview", "rapport-q3.pdf");
    UploadSeq.enterZone(520, 96);
  }
  if (!dropped) {
    const x = 520 - Math.min(1, t / 0.9) * 260;
    UploadSeq.updateCursor(x, 96);
    if (t >= 1.2) {
      dropped = true;
      UploadSeq.performDrop();
    }
  }
  canvas.draw(UploadSeq.frame(), now / 1000);
  clock.textContent = `t = ${t.toFixed(2)} s${dropped ? "  (dropped)" : "  (dragging)"}`;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
