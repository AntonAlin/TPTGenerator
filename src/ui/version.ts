/**
 * The app's version, shown in the header and footer: the major.minor of package.json, so a release
 * changes it in one place.
 */
import { version } from '../../package.json';

export const APP_VERSION = version.split('.').slice(0, 2).join('.');
