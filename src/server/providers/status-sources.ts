// 공개 상태 API 목록 (Atlassian Statuspage 형식: {page}/api/v2/status.json).
// 2026-11-25에 kangdora에서 하나씩 불러 page.name · status.indicator가 오는 것만 넣었다.
// 여기 없는 서비스는 분석 뒤 AI 웹 검색으로 찾아서 검증한 뒤 DB(status_sources)에 저장한다 (status-registry.ts).

export interface StatusSource {
  /** 사람이 보는 상태 페이지 */
  pageUrl: string;
  /** Statuspage 형식 JSON */
  apiUrl: string;
}

const statuspage = (base: string): StatusSource => ({ pageUrl: base, apiUrl: `${base}/api/v2/status.json` });

/** ids: AI 판정의 서비스 id. 정확히 같거나 'id-'로 시작하면 맞는다 (notion-api → notion, anthropic-claude → anthropic) */
const BUILTIN: { ids: string[]; source: StatusSource }[] = [
  { ids: ['supabase'], source: statuspage('https://status.supabase.com') },
  { ids: ['toss-payments', 'toss', 'tosspayments'], source: statuspage('https://status.tosspayments.com') },
  { ids: ['github'], source: statuspage('https://www.githubstatus.com') },
  { ids: ['sentry'], source: statuspage('https://status.sentry.io') },
  { ids: ['openai'], source: statuspage('https://status.openai.com') },
  { ids: ['anthropic', 'claude'], source: statuspage('https://status.claude.com') },
  { ids: ['vercel'], source: statuspage('https://www.vercel-status.com') },
  { ids: ['cloudflare'], source: statuspage('https://www.cloudflarestatus.com') },
  { ids: ['twilio'], source: statuspage('https://status.twilio.com') },
  { ids: ['sendgrid', 'twilio-sendgrid'], source: statuspage('https://status.sendgrid.com') },
  { ids: ['notion'], source: statuspage('https://www.notion-status.com') },
  { ids: ['discord'], source: statuspage('https://discordstatus.com') },
  { ids: ['expo'], source: statuspage('https://status.expo.dev') },
  { ids: ['resend'], source: statuspage('https://resend-status.com') },
  { ids: ['netlify'], source: statuspage('https://www.netlifystatus.com') },
  { ids: ['mongodb'], source: statuspage('https://status.mongodb.com') },
  { ids: ['clerk'], source: statuspage('https://status.clerk.com') },
  { ids: ['linear'], source: statuspage('https://linearstatus.com') },
  { ids: ['figma'], source: statuspage('https://status.figma.com') },
  { ids: ['npm'], source: statuspage('https://status.npmjs.org') },
  { ids: ['pusher'], source: statuspage('https://status.pusher.com') },
  { ids: ['mailgun'], source: statuspage('https://status.mailgun.com') },
  { ids: ['mixpanel'], source: statuspage('https://status.mixpanel.com') },
  { ids: ['segment'], source: statuspage('https://status.segment.com') },
  { ids: ['digitalocean'], source: statuspage('https://status.digitalocean.com') },
  { ids: ['fly-io', 'flyio'], source: statuspage('https://status.fly.io') },
  { ids: ['render'], source: statuspage('https://status.render.com') },
  { ids: ['upstash'], source: statuspage('https://status.upstash.com') },
];

export function builtinStatus(serviceId: string): StatusSource | null {
  for (const b of BUILTIN) if (b.ids.some((id) => serviceId === id || serviceId.startsWith(`${id}-`))) return b.source;
  return null;
}
