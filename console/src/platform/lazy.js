import { lazy } from 'react';

/** A screen that loads only when it is opened: screen(() => import('./pages.jsx'), 'HealthPage'). */
export const screen = (load, name) => lazy(() => load().then((module) => ({ default: module[name] })));
