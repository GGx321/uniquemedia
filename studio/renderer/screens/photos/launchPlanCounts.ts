/**
 * What «Подача» (`launchFlirtyCaption`) and «Ножки» (`launchLegsRow`) read of a launch's plan (`LaunchPreview`): each avatar's new photos and whether it is blocked
 * (the plan's totals leave a blocked avatar out), and the plan's total of new photos.
 */
export interface LaunchPlanCounts {
  readonly avatars: readonly { readonly toGenerate: number; readonly blocked: unknown }[];
  readonly totals: { readonly toGenerate: number };
}
