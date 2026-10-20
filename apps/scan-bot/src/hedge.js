// Runs fn(); if it has not answered after `ms`, runs a second copy at the same time and takes whichever answers first
// (a request that stalls on a slow connection is rescued by its twin). Fails only when both fail.
export function hedge(fn, ms) {
  return new Promise((resolve, reject) => {
    let done = false, started = 0, failed = 0, timer = null;
    const finish = (f, v) => { if (!done) { done = true; clearTimeout(timer); f(v); } };
    const run = () => {
      if (done || started >= 2) return;
      started += 1;
      Promise.resolve().then(fn).then((v) => finish(resolve, v), (e) => {
        failed += 1;
        if (started < 2) run(); // the first one failed early: start the twin right away
        else if (failed >= 2) finish(reject, e);
      });
    };
    run();
    timer = setTimeout(run, ms);
  });
}
