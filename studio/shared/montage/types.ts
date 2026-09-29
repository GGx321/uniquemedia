/** A pixel rectangle: the top-left corner and the size, all integers. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** A pixel size, integers. */
export interface Size {
  readonly w: number;
  readonly h: number;
}
