/**
 * Vue/Nuxt compiler-macro and auto-import constant sets split out of vue.ts.
 */

/**
 * Vue 3 compiler macros — compiler-provided, not user code
 */
export const VUE_COMPILER_MACROS = new Set([
  'defineProps',
  'defineEmits',
  'defineExpose',
  'defineOptions',
  'defineSlots',
  'defineModel',
  'withDefaults',
]);

/**
 * Nuxt auto-imported composables and utilities
 */
export const NUXT_AUTO_IMPORTS = new Set([
  // Routing
  'useRoute',
  'useRouter',
  'navigateTo',
  'abortNavigation',
  // Data fetching
  'useFetch',
  'useAsyncData',
  'useLazyFetch',
  'useLazyAsyncData',
  'refreshNuxtData',
  // State
  'useState',
  'clearNuxtState',
  // Head
  'useHead',
  'useSeoMeta',
  'useServerSeoMeta',
  // Runtime
  'useRuntimeConfig',
  'useAppConfig',
  'useNuxtApp',
  // Cookies
  'useCookie',
  // Error
  'useError',
  'createError',
  'showError',
  'clearError',
  // Page/layout
  'definePageMeta',
  'defineNuxtConfig',
  'defineNuxtPlugin',
  'defineNuxtRouteMiddleware',
  // Request
  'useRequestHeaders',
  'useRequestEvent',
  'useRequestFetch',
  'useRequestURL',
]);

/**
 * Nuxt virtual module prefixes (auto-import namespaces)
 */
export const NUXT_VIRTUAL_MODULES = [
  '#imports',
  '#components',
  '#app',
  '#build',
  '#head',
];

