const STATION_EMOJI: Record<string, string> = {
  spec: '📋',
  design: '🎨',
  build: '🔧',
  qa: '🔍',
  bugfix: '🐛',
  done: '✅',
  blocked: '🚫',
};

export async function notifyDiscord(
  msg: string,
  webhookUrl: string,
  log: (msg: string) => void,
): Promise<void> {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
    });
  } catch (e: any) {
    log(`Discord notify failed: ${e.message}`);
  }
}

export async function notifyStation(
  issueNumber: number,
  issueTitle: string,
  station: string,
  webhookUrl: string,
  log: (msg: string) => void,
): Promise<void> {
  const emoji = STATION_EMOJI[station] ?? '⏳';
  const shortTitle = issueTitle.replace(/^\[.*?\]\s*/, '').substring(0, 60);
  await notifyDiscord(
    `${emoji} **#${issueNumber}** → \`station:${station}\` | ${shortTitle}`,
    webhookUrl,
    log,
  );
}
