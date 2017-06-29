import * as glob from 'glob';
import * as fs from 'fs';
import * as path from 'path';

export interface Mapgen {
  type: "mapgen";
  object: MapgenObject;
  method: "json" | "lua";
  om_terrain: string[]; // | string[][]
  weight?: number;
}
export interface MapgenObject {
  fill_ter: string;
  rows: Array<string>;
  terrain: {[sym: string]: any};
  furniture: {[sym: string]: any};
  place_loot?: Array<PlaceLoot>;
  place_monsters?: Array<PlaceMonsters>;
}
export type PlaceLoot = {
  x: [number, number] | [number];
  y: [number, number] | [number];
  group: string;
  chance?: number;
  repeat?: number | [number] | [number, number];
};
export type PlaceMonsters = {
  x: [number, number] | [number];
  y: [number, number] | [number];
  monster: string;
  chance?: number;
  repeat?: number | [number] | [number, number];
};

export interface CddaData {
  objects: Array<any>;
  terrain: {[id: string]: any};
  furniture: {[id: string]: any};
  tilesets: any;
  item_group: {[id: string]: any};
  item: {[id: string]: any};
  monstergroup: {[id: string]: any};
  monster: {[id: string]: any};
}

export function loadCDDAData(root: string): CddaData {
  const filenames = glob.sync(root + '/data/json/**/*.json', {nodir: true});
  const objects = Array.prototype.concat.apply([], filenames.map((fn: string) => {
    const json = JSON.parse(fs.readFileSync(fn).toString())
    return (Array.isArray(json) ? json : [json]).map((x, i) => ({...x, _source: [fn, i]}));
  }));
  const tilesetConfigs = glob.sync(root + '/gfx/*/tile_config.json')
  const tilesets = tilesetConfigs.map((fn: string) => {
    const tsRoot = path.dirname(fn)
    try {
      const tileConfig = JSON.parse(fs.readFileSync(fn).toString())
      return {root: tsRoot, config: tileConfig};
    } catch (e) {
      return {root: tsRoot, config: {}};
    }
  }).filter(({config}: any) => 'tiles-new' in config);
  const terrain: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'terrain').forEach((t: any) => terrain[t.id] = t);
  const furniture: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'furniture').forEach((t: any) => furniture[t.id] = t);
  const item_group: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'item_group').forEach((t: any) => item_group[t.id] = t);
  const item: {[id: string]: any} = {};
  // See https://github.com/CleverRaven/Cataclysm-DDA/blob/dbf94ea32432320fc874237d93965c069fb674f3/src/init.cpp#L192
  const itemTypes = new Set([
    "AMMO",
    "GUN",
    "ARMOR",
    "TOOL",
    "TOOLMOD",
    "TOOL_ARMOR",
    "BOOK",
    "COMESTIBLE",
    "CONTAINER",
    "ENGINE",
    "WHEEL",
    "FUEL",
    "GUNMOD",
    "MAGAZINE",
    "GENERIC",
    "BIONIC_ITEM",
  ]);
  objects.filter((o: any) => itemTypes.has(o.type)).forEach((t: any) => item[t.id] = t);
  const monstergroup: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'monstergroup').forEach((t: any) => monstergroup[t.name] = t);
  const monster: {[id: string]: any} = {};
  objects.filter((o: any) => o.type === 'MONSTER').forEach((t: any) => monster[t.id] = t);

  return {objects, terrain, furniture, tilesets, item_group, item, monstergroup, monster};
}

export const emptyMapgen: Mapgen = {
  type: 'mapgen',
  method: 'json',
  om_terrain: ['house'],
  object: {
    fill_ter: 't_rock',
    rows: Array.apply(null, Array(24)).map(() => '                        '),
    terrain: {},
    furniture: {}
  }
};
