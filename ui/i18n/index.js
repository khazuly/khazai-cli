import { createElement as h, createContext, useContext } from "react";

const CONTEXTS = {};

/**
 * Load and cache a locale JSON file.
 * @param {string} locale
 * @returns {object}
 */
function loadLocale(locale) {
  if (!CONTEXTS[locale]) {
    try {
      CONTEXTS[locale] = require(`./${locale}.json`);
    } catch {
      CONTEXTS[locale] = require("./en.json");
    }
    CONTEXTS[locale]._loaded = true;
  }
  return Object.assign({ locale }, CONTEXTS[locale].messages);
}

/**
 * Simple string formatter for {placeholder} replacement.
 */
function substitute(text, params = {}) {
  return text.replace(/\{(\w+)\}/g, (match, key) =>
    params[key] !== undefined ? params[key] : match
  );
}

function getNested(obj, path) {
  const parts = path.split(".");
  let value = obj;
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
}

/**
 * Create an i18n object for a specific locale.
 * @param {string} [locale=en] - locale name
 * @returns {object}
 *   - t(path, params): get a translated string with optional {placeholder}
 *   - tn(path, count, params): get a translated string with plurals
 *   - get(path): raw value
 *   - locale: the current locale string
 */
export function createI18n(locale = "en") {
  const messages = loadLocale(locale);

  function get(path) {
    return getNested(messages, path);
  }

  function t(path, params) {
    const value = getNested(messages, path);
    if (value === undefined || value === null) return path;
    if (params && typeof value === "string") return substitute(value, params);
    if (Array.isArray(value)) return value;
    return value;
  }

  function tn(path, count, params = {}) {
    const singular = getNested(messages, `${path}_one`);
    const plural = getNested(messages, `${path}_other`);
    if (singular === undefined || plural === undefined) {
      return t(`${path}_${count}`, params) || t(path, { count, ...params });
    }
    const text = count === 1 ? singular : (getNested(messages, `${path}_${count}`) || plural);
    return substitute(text, { count, ...params });
  }

  return { t, tn, get, locale };
}

const I18nContext = createContext(createI18n("en"));

/**
 * Provide i18n to the component tree.
 * @param {object} props
 * @param {string} props.locale - locale name
 * @param {*} props.children
 */
export function I18nProvider({ locale = "en", children }) {
  const i18n = createI18n(locale);
  return h(I18nContext.Provider, { value: i18n }, children);
}

/**
 * React hook to access i18n functions.
 * @returns { {t: Function, tn: Function, get: Function, locale: string} }
 */
export function useI18n() {
  return useContext(I18nContext);
}

export { getNested };
