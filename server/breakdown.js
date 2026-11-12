// Rule-based "tiny step" breakdown. The first step is always tiny (<= 2 minutes)
// so starting feels easy; the rest ramp up gently.
const REASON_TIPS = {
  overwhelm: 'Only do this one step. Ignore the rest for now.',
  boredom: 'Put on a song and make this step a small game.',
  fear: 'This is a rough draft. It is allowed to be bad.',
  unclear: 'Write down what "done" looks like in one sentence.',
  tired: 'Stand up, drink water, then take this step.',
};

export function breakdown(title, reason) {
  const t = title.trim().replace(/\s+/g, ' ');
  const steps = [
    { text: `Get ready: open what you need for "${t}" and clear your space`, minutes: 2 },
    { text: `Do the tiniest possible piece of "${t}" (just 2 minutes, then you may stop)`, minutes: 2 },
    { text: 'Keep going on the next small piece, no polishing yet', minutes: 10 },
    { text: 'Do one more round, or note exactly where you will pick up next', minutes: 10 },
    { text: 'Quick review: what is done, what is left? Celebrate the progress', minutes: 3 },
  ];
  const tip = REASON_TIPS[reason];
  if (tip) steps[0].text += `. Tip: ${tip}`;
  return steps;
}

export const REASONS = Object.keys(REASON_TIPS);
