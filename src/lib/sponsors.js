// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// Where a gift can go, if anyone wants to send one. F42, D48.
//
// This file is the whole feature. An empty list means the section on the options
// page stays hidden, which is how it ships until the maintainer has accounts:
// the plumbing lands, the wording lands, GOVERNANCE.md is amended in the same
// commit, and turning it on later is one entry here rather than a change spread
// across three files.
//
// Links only. The extension never contacts any of these: `chrome.tabs.create`
// hands the address to the browser, and the browser makes the request, which is
// the same reasoning that lets an upload be handed off without a byte of network
// access of our own. `connect-src 'none'` stays literally true.

/**
 * @typedef {{ label: string, url: string, note: string }} Sponsor
 */

/** @type {Sponsor[]} */
export const SPONSORS = [
  // Filled in when the accounts exist. Two candidates, from DECISIONS.md D48:
  //
  //   { label: 'GitHub Sponsors', url: 'https://github.com/sponsors/<user>',
  //     note: 'The repository is this product\'s shop window' },
  //   { label: 'Open Collective', url: 'https://opencollective.com/<slug>',
  //     note: 'Publishes every rupee in and out' },
];

/**
 * Only addresses we chose, and only over https.
 *
 * The list above is a constant in the shipped source, so this cannot currently
 * be reached by anything a page or a user controls. It is here because that is a
 * property of today's list rather than of the code, and the day someone adds a
 * setting for a custom link is the day this stops being obvious.
 */
export function sponsorLink(sponsor) {
  const url = String(sponsor?.url ?? '');
  if (!/^https:\/\/[a-z0-9.-]+\/[^\s"'<>]*$/i.test(url)) return null;
  return { label: String(sponsor.label ?? 'Support'), url, note: String(sponsor.note ?? '') };
}

/** The entries that are usable, which is what the page should render. */
export const usableSponsors = () => SPONSORS.map(sponsorLink).filter(Boolean);
