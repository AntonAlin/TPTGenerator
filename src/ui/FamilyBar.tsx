/**
 * The bar both free apps share (Nexus Portfolio Lab and TPT Generator): their logos, a switch to the
 * other one, and what they have in common. The same markup and CSS live in options-lab
 * (js/familybar.js), so the two look like one family. Logos are inline SVG: nothing is fetched.
 */
export const NEXUS_URL_ROOT = 'https://nexus.alin.one/';
export const TPT_URL_ROOT = 'https://tptgenerator.alin.one/';

export function NexusLogo({ size = 18 }: { size?: number }) {
  return (
    <svg class="fb-logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="fb-g-nexus" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#6366f1" />
          <stop offset="0.55" stop-color="#8b5cf6" />
          <stop offset="1" stop-color="#22d3ee" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#fb-g-nexus)" />
      <path d="M13 45l13-15 11 8 15-19" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round" />
      <circle cx="52" cy="19" r="4.5" fill="#8fe0b0" />
    </svg>
  );
}

export function TptLogo({ size = 18 }: { size?: number }) {
  return (
    <svg class="fb-logo" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <linearGradient id="fb-g-tpt" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#1c4583" />
          <stop offset="1" stop-color="#3577cf" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill="url(#fb-g-tpt)" />
      <g fill="#fff" opacity="0.55">
        <rect x="9" y="17" width="14" height="5" rx="2.5" />
        <rect x="13" y="29.5" width="9" height="5" rx="2.5" />
        <rect x="10" y="42" width="12" height="5" rx="2.5" />
      </g>
      <path d="M28 24 L35 32 L28 40" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" />
      <g fill="#fff">
        <rect x="39" y="15" width="6.5" height="9" rx="2" />
        <rect x="47.5" y="15" width="6.5" height="9" rx="2" />
        <rect x="39" y="27.5" width="6.5" height="9" rx="2" />
        <rect x="47.5" y="27.5" width="6.5" height="9" rx="2" />
        <rect x="39" y="40" width="6.5" height="9" rx="2" />
        <rect x="47.5" y="40" width="6.5" height="9" rx="2" fill="#8fe0b0" />
      </g>
    </svg>
  );
}

export function FamilyBar({ current }: { current: 'nexus' | 'tpt' }) {
  return (
    <nav class="family-bar" aria-label="Free apps by Anton Ålin">
      <a class="fb-app" href={NEXUS_URL_ROOT} aria-current={current === 'nexus' ? 'page' : undefined}>
        <NexusLogo />
        <span class="fb-name">Nexus Portfolio Lab</span>
        <span class="fb-short">Nexus</span>
      </a>
      <a class="fb-app" href={TPT_URL_ROOT} aria-current={current === 'tpt' ? 'page' : undefined}>
        <TptLogo />
        <span class="fb-name">TPT Generator</span>
        <span class="fb-short">TPT</span>
      </a>
      <span class="fb-note">Free tools for fund managers · nothing leaves your browser</span>
    </nav>
  );
}
