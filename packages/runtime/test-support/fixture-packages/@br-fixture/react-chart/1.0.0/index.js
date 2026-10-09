// A react-chartjs-2-like package (T-040 fixture): reads the chart registry the app filled.
import { createElement } from 'react';
import { VERSION, lookup } from '@br-fixture/chart';
export function Chart({ scale }) {
  const text =
    lookup(scale) === null
      ? `"${scale}" is not a registered scale`
      : `scale ${scale} from chart ${VERSION}`;
  return createElement('span', { 'data-testid': 'chart' }, text);
}
