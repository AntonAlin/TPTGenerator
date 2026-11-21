/**
 * Affiliate banner, always labelled as one (same banner as Nexus Portfolio Lab).
 * The image is served from this site, so nothing is requested from the advertiser
 * unless someone clicks; the link opens in a new tab without a referrer.
 */
export const AD_URL = 'https://go.nordvpn.net/aff_c?offer_id=15&aff_id=160913&url_id=902';

export function Promo() {
  return (
    <aside class="promo" aria-label="Advertisement · affiliate link">
      <div class="promo-label">Advertisement · affiliate link</div>
      <a class="promo-link" href={AD_URL} target="_blank" rel="sponsored noopener noreferrer">
        <img src="img/nordvpn.webp" width={700} height={350} loading="lazy" decoding="async" alt="NordVPN Black Friday: up to 77% off plus 3 extra months" />
      </a>
      <div class="promo-note">I get a commission if you buy through this link, at no extra cost to you.</div>
    </aside>
  );
}
