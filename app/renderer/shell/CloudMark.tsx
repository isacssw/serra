// The small mark beside a profile whose agent is eve on Vercel (SB-17): an icon only, never the word, so the row
// reads like any other profile. Its host is in the tooltip and in the row's spoken label (`rowLabel`).
import { Cloud } from 'lucide-react';

export const CloudMark = ({ host }: { host: string | null }) =>
  host ? <span title={`Agent at ${host}`} className="inline-flex shrink-0 text-faint" data-cloud={host}><Cloud size={12} strokeWidth={1.75} aria-hidden /></span> : null;
