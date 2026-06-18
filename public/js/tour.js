// Phase 13: guided product tour for first-time users (Driver.js).
//
// Behaviour:
//   - Auto-starts ONCE for a brand-new user on their first dashboard visit. The
//     "new user" signal is the server has_visited_dashboard flag, snapshotted by
//     App.init into App.isNewUser BEFORE the greeting consumes/flips it.
//   - A localStorage guard (AUTOSTART_KEY) means it auto-fires at most once per
//     browser even if the server-side visit write never lands. It never force-
//     reopens for returning users.
//   - The topbar "Take a tour" button calls Tour.start() to replay it on demand,
//     ignoring all guards.
//
// The app stays EMPTY for a new user: the tour points at empty-state elements and
// explains what WILL appear. It never injects demo competitors or briefs.
//
// EDITING THE TOUR: every step (target, title, copy, order) lives in the STEPS
// array below and nowhere else. To revise wording or what an arrow points at,
// edit that one array. Copy must follow CLAUDE.md: no em-dashes, en-dashes, or
// connector-plus.

const Tour = {
  // localStorage key recording that the tour already auto-started for this
  // browser, so it never auto-fires a second time.
  AUTOSTART_KEY: 'cs-tour-autostarted',

  // ── EDIT TOUR STEPS HERE ─────────────────────────────────────────────────────
  // element : CSS selector of the node to spotlight. Omit it for a centered,
  //           no-highlight step (used where the real target is off-canvas on
  //           mobile, e.g. the sidebar).
  // title   : short heading shown in the tooltip.
  // text    : one or two sentences of body copy.
  // side    : preferred tooltip placement ('top'|'bottom'|'left'|'right').
  // align   : alignment along that side ('start'|'center'|'end').
  // A step whose element is not on the current page is skipped automatically.
  STEPS: [
    {
      element: '[data-tour="add-competitor"]',
      title: 'Start here',
      text: "Add a competitor's website, such as their pricing page, changelog, or blog, and Nivaria will monitor it for you.",
      side: 'top', align: 'start',
    },
    {
      element: '[data-tour="briefs"]',
      title: 'Your AI briefs land here',
      text: 'Whenever a competitor makes a meaningful change, a brief appears: what changed, why it matters, and what to say about it.',
      side: 'top', align: 'start',
    },
    {
      element: '[data-tour="monitoring"]',
      title: 'What we watch',
      text: 'Nivaria checks publicly available pages, like pricing, features, and announcements, once a day.',
      side: 'bottom', align: 'start',
    },
    {
      // No element: a centered popover, so it works at 375px where the sidebar is
      // off-canvas. Points the user to where configuration lives.
      title: 'Set yourself up',
      text: 'Open Settings and Profile from the menu to add your business context and choose how you get notified.',
    },
    {
      element: '[data-tour="add-competitor"]',
      title: 'Add your first competitor to get started',
      text: 'Pick one rival to track. You can add more anytime, and your first brief follows the next change we detect.',
      side: 'top', align: 'start',
    },
  ],
  // ── /EDIT TOUR STEPS HERE ────────────────────────────────────────────────────

  _driver: null,

  available() {
    return !!(window.driver && window.driver.js && typeof window.driver.js.driver === 'function');
  },

  // Translate the flat STEPS config into the shape Driver.js expects.
  _buildSteps() {
    return Tour.STEPS.map(s => ({
      element: s.element || undefined,
      popover: {
        title: s.title,
        description: s.text,
        side: s.side || 'bottom',
        align: s.align || 'start',
      },
    }));
  },

  // Launch the tour immediately. Used by the manual button and by autostart.
  start() {
    if (!Tour.available()) {
      try { toast('The tour could not load. Please refresh and try again.', 'error'); } catch (_) {}
      return;
    }
    // Drop steps whose target is absent on this page (e.g. replaying from a page
    // that lacks the dashboard anchors), so the flow never points at nothing.
    const steps = Tour._buildSteps().filter(st => !st.element || document.querySelector(st.element));
    if (!steps.length) return;

    const factory = window.driver.js.driver;
    Tour._driver = factory({
      showProgress: true,
      progressText: 'Step {{current}} of {{total}}',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Done',
      popoverClass: 'nivaria-tour',
      overlayColor: '#05060a',
      overlayOpacity: 0.72,
      stagePadding: 6,
      stageRadius: 12,
      allowClose: true, // Esc, the X, and an overlay click all dismiss the tour
      steps,
    });
    Tour._driver.drive();
  },

  // Auto-start at most once for a first-time user. Called after the dashboard
  // finishes rendering so the spotlighted nodes exist and are measurable.
  maybeAutoStart() {
    if (!window.App || !App.isNewUser) return;
    try { if (localStorage.getItem(Tour.AUTOSTART_KEY)) return; } catch (_) {}
    try { localStorage.setItem(Tour.AUTOSTART_KEY, String(Date.now())); } catch (_) {}
    // Defer a beat so layout/animations settle before measuring element rects.
    setTimeout(() => Tour.start(), 400);
  },
};

window.Tour = Tour;
