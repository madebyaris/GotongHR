import { readFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("RSS sampler must run as a worker.");
}

const port = parentPort;
let peak = 0;
let hwmFloor = 0;
let timer;

function readKb(field) {
  const status = readFileSync("/proc/self/status", "utf8");
  const match = new RegExp(`^${field}:\\s+(\\d+)\\s+kB$`, "m").exec(status);
  return match?.[1] === undefined ? 0 : Number(match[1]) * 1024;
}

function sample() {
  const rss = readKb("VmRSS");
  const hwm = readKb("VmHWM");
  peak = Math.max(peak, rss);
  if (hwm > hwmFloor) {
    peak = Math.max(peak, hwm);
  }
}

port.on("message", (message) => {
  if (message?.type === "arm") {
    peak = 0;
    hwmFloor = message.hwmBefore;
    sample();
    timer = globalThis.setInterval(sample, 1);
    port.postMessage("armed");
    return;
  }
  if (message?.type === "stop") {
    globalThis.clearInterval(timer);
    sample();
    port.postMessage(peak);
  }
});
