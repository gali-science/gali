(() => {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const nav = document.querySelector("[data-nav]");

  const onNavScroll = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
  onNavScroll();
  window.addEventListener("scroll", onNavScroll, { passive: true });

  const heroBrand = document.querySelector(".hero-brand");
  new IntersectionObserver(([entry]) => nav.classList.toggle("is-past-brand", !entry.isIntersecting), {
    rootMargin: `-${nav.offsetHeight}px 0px 0px 0px`,
  }).observe(heroBrand);

  let filmOpen = false;
  let syncPlayback = () => {};

  const tour = document.querySelector("[data-tour]");
  if (tour) {
    const tabsEl = tour.querySelector("[data-tabs]");
    const caption = tour.querySelector("[data-caption]");
    const toggle = tour.querySelector("[data-tour-toggle]");
    const picks = [...tour.querySelectorAll("[data-story-pick]")];
    const shots = [...tour.querySelectorAll("img[data-shot]")];
    const steps = [...tour.querySelectorAll("[data-script] > li")].map((li) => ({
      story: Number(li.dataset.story),
      label: li.dataset.label,
      shot: li.dataset.shot,
      pre: li.dataset.pre ?? null,
      lines: [...li.querySelectorAll("p")]
        .map((p) => ({ who: p.dataset.who, text: p.textContent.trim() }))
        .filter((line) => line.text),
    }));
    const storyCount = new Set(steps.map((step) => step.story)).size;
    const FIRST_LINE_MS = 350;
    const AFTER_YOU_MS = 1700;
    const AFTER_GALI_MS = 2400;

    let story = -1;
    let index = -1;
    let tabs = [];
    let timers = [];
    let playing = !reduced.matches;
    let visible = false;
    let hovering = false;

    const stepsOf = (s) => steps.filter((step) => step.story === s);
    const current = () => stepsOf(story)[index];

    const showShot = (name) => {
      for (const shot of shots) {
        const on = shot.dataset.shot === name;
        if (on) shot.loading = "eager";
        shot.classList.toggle("is-on", on);
      }
    };

    const captionLine = (line) => {
      const row = document.createElement("p");
      row.className = `cap ${line.who === "Gali" ? "cap-gali" : "cap-you"}`;
      const who = document.createElement("span");
      who.className = "cap-who";
      who.innerHTML = '<span class="cap-wave" aria-hidden="true"><i></i><i></i><i></i></span>';
      who.append(line.who);
      const text = document.createElement("span");
      text.className = "cap-text";
      text.textContent = line.text;
      row.append(who, text);
      return row;
    };

    const clearTimers = () => {
      for (const timer of timers) window.clearTimeout(timer);
      timers = [];
    };

    const renderCaption = (step, animate) => {
      clearTimers();
      const rows = step.lines.map(captionLine);
      caption.replaceChildren(...rows);
      if (!animate || reduced.matches) {
        for (const row of rows) row.classList.add("is-in");
        showShot(step.shot);
        return;
      }
      showShot(step.pre ?? step.shot);
      let at = FIRST_LINE_MS;
      rows.forEach((row, k) => {
        const line = step.lines[k];
        timers.push(
          window.setTimeout(() => {
            for (const other of rows) other.classList.remove("is-talking");
            row.classList.add("is-in", "is-talking");
            if (line.who === "Gali") showShot(step.shot);
          }, at),
        );
        at += line.who === "You" ? AFTER_YOU_MS : AFTER_GALI_MS;
      });
      timers.push(
        window.setTimeout(() => {
          for (const row of rows) row.classList.remove("is-talking");
        }, at),
      );
    };

    const reserveCaption = () => {
      caption.style.minHeight = "";
      let tallest = 0;
      for (const step of steps) {
        const rows = step.lines.map(captionLine);
        for (const row of rows) row.classList.add("is-in");
        caption.replaceChildren(...rows);
        tallest = Math.max(tallest, caption.offsetHeight);
      }
      caption.style.minHeight = `${tallest}px`;
      if (index >= 0) renderCaption(current(), false);
    };

    syncPlayback = () => {
      tour.classList.toggle("is-playing", playing);
      tour.classList.toggle("is-paused", !(playing && visible && !hovering && !filmOpen && !document.hidden));
      toggle.setAttribute("aria-label", playing ? "Pause walkthrough" : "Play walkthrough");
    };

    const advance = () => {
      if (index + 1 < stepsOf(story).length) go(story, index + 1);
      else go((story + 1) % storyCount, 0);
    };

    const buildTabs = () => {
      tabs = stepsOf(story).map((step, j) => {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "tour-tab";
        tab.innerHTML = '<span class="tour-tab-bar" aria-hidden="true"><span></span></span><span class="tour-tab-label"></span>';
        tab.querySelector(".tour-tab-label").textContent = step.label;
        tab.querySelector(".tour-tab-bar > span").addEventListener("animationend", () => {
          if (j === index && playing) advance();
        });
        tab.addEventListener("click", () => go(story, j));
        tab.addEventListener("keydown", (event) => {
          const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
          if (!delta) return;
          event.preventDefault();
          const next = (j + delta + tabs.length) % tabs.length;
          go(story, next);
          tabs[next].focus();
        });
        return tab;
      });
      tabsEl.replaceChildren(...tabs);
    };

    const go = (s, j, animate = true) => {
      if (s !== story) {
        story = s;
        buildTabs();
        for (const pick of picks) pick.setAttribute("aria-pressed", String(Number(pick.dataset.storyPick) === s));
      }
      index = j;
      tabs.forEach((tab, k) => {
        tab.setAttribute("aria-pressed", String(k === j));
        tab.classList.toggle("is-done", k < j);
        tab.classList.remove("is-running");
      });
      void tabs[j].offsetWidth;
      tabs[j].classList.add("is-running");
      renderCaption(current(), animate);
    };

    toggle.addEventListener("click", () => {
      playing = !playing;
      syncPlayback();
    });

    let arrived = false;
    for (const pick of picks) {
      pick.addEventListener("click", () => {
        arrived = true;
        go(Number(pick.dataset.storyPick), 0);
      });
    }
    document.querySelectorAll("[data-story-open]").forEach((link) => {
      link.addEventListener("click", () => {
        arrived = true;
        go(Number(link.dataset.storyOpen), 0);
      });
    });

    const stage = tour.querySelector(".tour-stage");
    stage.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "mouse") return;
      hovering = true;
      syncPlayback();
    });
    stage.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "mouse") return;
      hovering = false;
      syncPlayback();
    });

    new IntersectionObserver(
      (entries) => {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible && !arrived) {
          arrived = true;
          go(0, 0);
        }
        syncPlayback();
      },
      { threshold: 0.35 },
    ).observe(tour);
    document.addEventListener("visibilitychange", syncPlayback);

    let resizeTimer = 0;
    let lastWidth = window.innerWidth;
    window.addEventListener("resize", () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(reserveCaption, 150);
    });

    go(0, 0, false);
    syncPlayback();
    document.fonts.ready.then(reserveCaption);
  }

  const film = document.querySelector("[data-film]");
  if (film) {
    const filmVideo = film.querySelector("[data-film-video]");
    const filmSrc = () => {
      const wide = window.screen.width * window.devicePixelRatio >= 1600;
      return `${filmVideo.dataset.src}-${wide ? 1080 : 720}.mp4`;
    };

    const openFilm = (event) => {
      event.preventDefault();
      if (!filmVideo.src) {
        filmVideo.poster = filmVideo.dataset.poster;
        filmVideo.src = filmSrc();
      }
      film.showModal();
      filmOpen = true;
      syncPlayback();
      filmVideo.play().catch(() => {});
    };

    document.querySelectorAll("[data-film-open]").forEach((link) => link.addEventListener("click", openFilm));
    film.querySelector("[data-film-close]").addEventListener("click", () => film.close());
    film.addEventListener("click", (event) => {
      if (event.target === film) film.close();
    });
    film.addEventListener("close", () => {
      filmVideo.pause();
      filmOpen = false;
      syncPlayback();
    });
    filmVideo.addEventListener("ended", () => film.close());
  }

  const openTargetDetails = () => {
    const target = window.location.hash ? document.getElementById(window.location.hash.slice(1)) : null;
    if (target instanceof HTMLDetailsElement) target.open = true;
  };
  window.addEventListener("hashchange", openTargetDetails);
  openTargetDetails();

  const reveals = document.querySelectorAll(".reveal");
  if (reduced.matches || !("IntersectionObserver" in window)) {
    reveals.forEach((el) => el.classList.add("is-in"));
  } else {
    const revealObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    reveals.forEach((el) => {
      if (el.getBoundingClientRect().top < window.innerHeight) {
        requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("is-in")));
      } else {
        revealObserver.observe(el);
      }
    });
  }
})();
