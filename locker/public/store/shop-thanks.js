import { bindInstallation, resolveOS } from './shop-platform.mjs';

// Preserve the visitor's OS through Stripe, even in the Linux cloud browser.
bindInstallation(document, resolveOS(location.search, navigator), command => navigator.clipboard.writeText(command));
