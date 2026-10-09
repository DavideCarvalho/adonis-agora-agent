import { cn } from '@/lib/utils';

export interface SliderProps {
  /** The current values (one thumb per value). */
  value: number[];
  /** Called with the new values while dragging. */
  onValueChange?: (value: number[]) => void;
  min?: number;
  max?: number;
  /** @default 1 */
  step?: number;
  className?: string;
}

/** A range slider. */
export function Slider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  className,
}: SliderProps) {
  return (
    <input
      type="range"
      className={cn('slider', className)}
      min={min}
      max={max}
      step={step}
      value={value[0] ?? min}
      onChange={(event) => onValueChange?.([Number(event.target.value)])}
    />
  );
}
