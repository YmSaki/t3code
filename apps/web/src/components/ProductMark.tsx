import type { SVGProps } from "react";
import iconUrl from "../../../../assets/fork/icon.svg";

export function ProductMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
      <image href={iconUrl} width="128" height="128" />
    </svg>
  );
}
