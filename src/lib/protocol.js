// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Palaniappan
//
// The version of the messages that travel over the ports between the service
// worker, the result tab and the progress panel.
//
// WHY THIS EXISTS
//
// Chrome updates an extension by replacing the service worker while the pages
// it opened stay exactly as they were. A result tab opened five minutes ago is
// still running the old code, and the new worker will happily post messages to
// it. Today those messages have the same shape and nothing goes wrong. The
// moment the shape changes, and ROADMAP F10 changes it by splitting a capture
// into parts, the old tab reads a message it does not understand and fails in
// the worst available way: silently, with a progress bar that never fills.
//
// One number on every message turns that into a sentence the user can act on.
//
// WHICH DIRECTION IS CHECKED, AND WHY THAT IS ENOUGH
//
// Only the worker can be newer than the page. A page's code is loaded from the
// extension package when the tab opens, and a worker started after that comes
// from the same package or a later one, never an earlier one. So the case to
// catch is a new worker talking to an old page, and it is caught by the page
// checking what it receives.
//
// The pages stamp what they send anyway, and the worker refuses a command it
// does not recognise. There is exactly one such command, Finish now, and
// refusing it means the capture completes normally rather than early, which
// loses nobody any work.

/**
 * Raise this whenever the shape of a port message changes: a field removed, a
 * field's meaning changed, or a new message type that an older reader would
 * mishandle rather than ignore.
 */
export const PROTOCOL_VERSION = 1;

/** Stamp a message as ours. Every port send goes through this. */
export const sealed = (message) => ({ ...message, protocol: PROTOCOL_VERSION });

/** Was this message written by a build that agrees with us about its shape? */
export const speaksOurProtocol = (message) => message?.protocol === PROTOCOL_VERSION;

/**
 * What the user is told. Names the cause, because "something went wrong" gives
 * them nothing to do and this has an obvious remedy.
 */
export const PROTOCOL_MISMATCH =
  'OpenFullPage updated while this capture was running, so this tab and the '
  + 'extension no longer agree. Nothing was lost from the page. Capture it again.';
