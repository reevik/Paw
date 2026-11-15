// Pomodoro: a focus timer in the status bar.
//   /pomodoro          25 minutes
//   /pomodoro 50       50 minutes
//   /pomodoro stop     stop it

let timer = null;
let endsAt = 0;
let minutes = 25;
let tab = null;

const pad = (n) => String(n).padStart(2, "0");

function tick() {
  const left = Math.max(0, Math.round((endsAt - Date.now()) / 1000));
  paw.status(`🍅 ${pad(Math.floor(left / 60))}:${pad(left % 60)}`, { title: `${minutes}-minute focus session` });
  if (left === 0) {
    stop();
    paw.print(tab, `🍅 **${minutes} minutes are up.** Time for a break.`);
  }
}

function stop() {
  clearInterval(timer);
  timer = null;
  paw.status("");
}

paw.command("pomodoro", { description: "a focus timer in the status bar: /pomodoro [minutes | stop]", usage: "[minutes|stop]" }, (args, t) => {
  const arg = args.trim();
  if (arg === "stop") {
    if (!timer) return "No timer is running.";
    stop();
    return "Stopped the timer.";
  }
  const n = arg ? Number(arg) : 25;
  if (!Number.isFinite(n) || n <= 0 || n > 240) return "Give the minutes as a number from 1 to 240, or `stop`.";
  minutes = n;
  tab = t;
  endsAt = Date.now() + n * 60_000;
  clearInterval(timer);
  timer = setInterval(tick, 1000);
  tick();
  return `🍅 Focus for **${n} minutes**. The status bar counts down; \`/pomodoro stop\` ends it.`;
});
