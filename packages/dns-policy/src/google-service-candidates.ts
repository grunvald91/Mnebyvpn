/**
 * Initial Google service domain candidates, not a complete Google domain list.
 * This manifest cannot enable DNS rewrites or route HTTPS by itself.
 * Every entry remains in testing/unverified state until on-device DNS+TLS+RR
 * and foreign egress validation has completed.
 */
import type {DomainRouteRule} from './domain-routing.ts';

export const googleRouteCandidates: readonly DomainRouteRule[] = Object.freeze([
  // Egress TLS passthrough reached origin in foreign-only loopback tests.
  {domain:'gemini.google.com', status:'testing'},
  {domain:'aistudio.google.com', status:'testing'},
  {domain:'generativelanguage.googleapis.com', status:'testing'},
  {domain:'labs.google', status:'testing'},
  {domain:'accounts.google.com', status:'testing'},
  {domain:'www.google.com', status:'testing'},
  {domain:'www.youtube.com', status:'testing'},
  {domain:'www.gstatic.com', status:'testing'},

  // User-confirmed product entry points, NOT identified from VPN socket IPs.
  // Source Google Stitch: https://blog.google/innovation-and-ai/models-and-research/google-labs/stitch-gemini-3/
  // Source YouTube: https://support.google.com/youtube/answer/171780
  {domain:'stitch.withgoogle.com', status:'unverified'},
  {domain:'youtube.com', status:'unverified'},
  {domain:'m.youtube.com', status:'unverified'},
  {domain:'youtu.be', status:'unverified'},
  {domain:'s.ytimg.com', status:'unverified'},
  {domain:'yt3.ggpht.com', status:'unverified'},
  {domain:'accounts.youtube.com', status:'unverified'},
  {domain:'www.youtube-nocookie.com', status:'unverified'},

  // Known Google product hostnames, not measured through our SNI relay.
  {domain:'mail.google.com', status:'unverified'},
  {domain:'drive.google.com', status:'unverified'},
  {domain:'docs.google.com', status:'unverified'},
  {domain:'sheets.google.com', status:'unverified'},
  {domain:'calendar.google.com', status:'unverified'},
  {domain:'photos.google.com', status:'unverified'},
  {domain:'maps.google.com', status:'unverified'},
  {domain:'play.google.com', status:'unverified'},
  {domain:'myaccount.google.com', status:'unverified'},
  {domain:'oauth2.googleapis.com', status:'unverified'},
  {domain:'people.googleapis.com', status:'unverified'},
  {domain:'www.googleapis.com', status:'unverified'},
  {domain:'fonts.googleapis.com', status:'unverified'},
  {domain:'fonts.gstatic.com', status:'unverified'},
  {domain:'ssl.gstatic.com', status:'unverified'},
  {domain:'youtubei.googleapis.com', status:'unverified'},
  {domain:'i.ytimg.com', status:'unverified'},
  {domain:'storage.googleapis.com', status:'unverified'},
]);

export const googleRoutePolicyIsLive = false as const;
