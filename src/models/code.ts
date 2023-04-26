/* eslint-disable import/no-cycle */
import { Model } from 'objection';
import BaseModel from './base';
import { SmartContract } from './smart_contract';

export interface IInstantiatePermission {
  permission: string;
  address: string;
  addresses: string[];
}

export class Code extends BaseModel {
  code_id!: number;

  creator!: string;

  data_hash!: string;

  instantiate_permission!: IInstantiatePermission[];

  type: string | undefined;

  status: string | undefined;

  store_hash!: string;

  store_height!: number;

  static get tableName() {
    return 'code';
  }

  static get jsonAttributes() {
    return ['instantiate_permission'];
  }

  static get idColumn(): string | string[] {
    return 'code_id';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: [
        'code_id',
        'creator',
        'data_hash',
        'instantiate_permission',
        'store_hash',
        'store_height',
      ],
      properties: {
        code_id: { type: 'number' },
        creator: { type: 'string' },
        data_hash: { type: 'string' },
        instantiate_permission: {
          type: 'object',
          properties: {
            permission: { type: 'string' },
            address: { type: 'string' },
            addresses: { type: 'array', items: { type: 'string' } },
          },
        },
        type: { type: ['string', 'null'] },
        status: { type: ['string', 'null'] },
        store_hash: { type: 'string' },
        store_height: { type: 'number' },
      },
    };
  }

  static get relationMappings() {
    return {
      contracts: {
        relation: Model.HasManyRelation,
        modelClass: SmartContract,
        join: {
          from: 'code.code_id',
          to: 'smart_contract.code_id',
        },
      },
    };
  }
}
