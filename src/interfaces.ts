import { Stream } from 'xstream';
import { VNode, DOMSource } from '@cycle/dom';
import { HTTPSource, RequestOptions } from '@cycle/http';

export type Sources = {
    DOM : DOMSource;
};

export type RootSinks = {
    DOM : Stream<VNode>;
};

export type Sinks = Partial<RootSinks>;
export type Component = (s : Sources) => Sinks;
