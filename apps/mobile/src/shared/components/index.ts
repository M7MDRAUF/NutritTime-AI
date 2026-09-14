/**
 * Batch 1 of TSD 6.7's shared components (T-12-04).
 *
 * One import path for every screen and for the two batches that build on these: batch 2's state
 * components and batch 3's fields and cards compose from `AppText`, `Icon`, `Divider`, `Chip`
 * and the two buttons, and they import them from here rather than by file, so a component can be
 * split or renamed without touching a screen.
 *
 * `ICON_NAMES` is exported as a value because it is the runtime witness for `IconName` - a
 * caller validating a name off a route param or a stored preference needs the array, not the
 * type.
 */

export { AppText } from './AppText.js';
export type { AppTextProps, HeadingLevel, TextAlign, TextTone } from './AppText.js';

export { Icon, ICON_NAMES } from './Icon.js';
export type { IconName, IconProps } from './Icon.js';

export { Divider } from './Divider.js';
export type { DividerProps, DividerSpacing } from './Divider.js';

export { Chip } from './Chip.js';
export type { ChipProps } from './Chip.js';

export { AccessibleButton } from './AccessibleButton.js';
export type { AccessibleButtonProps, ButtonVariant } from './AccessibleButton.js';

export { IconButton } from './IconButton.js';
export type { IconButtonProps } from './IconButton.js';

/*
 * Batch 2 - the state components (T-12-05).
 *
 * Every one of them takes `stillAvailable`, the sentence PRD 12 requires: what happened, what
 * still works, what to do next. `StillAvailableNote` is NOT exported. It is the shared rendering
 * of that sentence, it lives in `StatusMessage.tsx` because T-12-05's file boundary permits no
 * sixth file, and TSD 6.7's inventory is sixteen components - it is not a seventeenth.
 */

export { EmptyState } from './EmptyState.js';
export type { EmptyStateProps } from './EmptyState.js';

export { ErrorState } from './ErrorState.js';
export type { ErrorStateProps } from './ErrorState.js';

export { OfflineState } from './OfflineState.js';
export type { OfflineStateProps } from './OfflineState.js';

export { StatusMessage } from './StatusMessage.js';
export type { StatusMessageProps, StatusTone } from './StatusMessage.js';

export { Toast } from './Toast.js';
export type { ToastProps } from './Toast.js';

/* Batch 3 - the content components (T-12-06). */

export { FormField } from './FormField.js';
export type { FormFieldProps } from './FormField.js';

export { SearchField } from './SearchField.js';
export type { SearchFieldProps } from './SearchField.js';

export { Sheet } from './Sheet.js';
export type { SheetInsets, SheetProps } from './Sheet.js';

export { MealCard } from './MealCard.js';
export type { MealCardProps } from './MealCard.js';

/*
 * `NUTRITION_UNAVAILABLE` is exported as a value because it is the one string T-16-03 has to
 * match: the meal-details screen renders a row of these badges and 53 of the 60 catalog records
 * carry `null` for all four macros (TSD 7.4's all-or-nothing rule), so a test asserting the
 * common case needs the constant rather than a retyped literal.
 */
export { NutritionBadge, NUTRITION_UNAVAILABLE } from './NutritionBadge.js';
export type { NutritionBadgeProps } from './NutritionBadge.js';
