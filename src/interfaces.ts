import { Stream } from 'xstream';
import { VNode, DOMSource } from '@cycle/dom';
import { HTTPSource, RequestOptions } from '@cycle/http';

export type ElectronOpenDialogMessage = {
  type: 'dialog',
  dialog: 'open',
  options: any,
}
export type ElectronSaveDialogMessage = {
  type: 'dialog',
  dialog: 'save',
  options: any,
  data: any,
}
export type ElectronMessage = ElectronOpenDialogMessage | ElectronSaveDialogMessage;

export type Sources = {
    DOM: DOMSource;
    electron: Stream<any>;
};

export type RootSinks = {
    DOM: Stream<VNode>;
    electron: Stream<ElectronMessage>;
};

export type Sinks = Partial<RootSinks>;
export type Component = (s : Sources) => Sinks;
