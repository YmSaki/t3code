export const PRODUCT_NAME = "T3CodeJP";
export const PRODUCT_SLUG = "t3codejp";
export const DESKTOP_APP_ID = "io.github.ymsaki.t3codejp";
export const DEFAULT_HOME_DIRECTORY = `.${PRODUCT_SLUG}`;

export const desktopScheme = (isDevelopment: boolean) =>
  isDevelopment ? `${PRODUCT_SLUG}-dev` : PRODUCT_SLUG;

export const isDesktopProtocol = (protocol: string): boolean =>
  protocol === `${desktopScheme(false)}:` || protocol === `${desktopScheme(true)}:`;
