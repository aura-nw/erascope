import { Model } from 'objection';
import BaseModel from './base';
// eslint-disable-next-line import/no-cycle
import CW721Contract from './cw721_contract';

export default class CW721Token extends BaseModel {
  token_id!: string;

  token_uri?: string;

  extension?: any;

  owner!: string;

  id?: number | undefined;

  contract_address!: string;

  created_at?: Date;

  updated_at?: Date;

  static get tableName() {
    return 'cw721_token';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['token_id', 'owner', 'contract_address'],
      properties: {
        token_id: { type: 'string' },
        contract_address: { type: 'string' },
        owner: { type: 'string' },
      },
    };
  }

  static get relationMappings() {
    return {
      contract: {
        relation: Model.BelongsToOneRelation,
        modelClass: CW721Contract,
        join: {
          to: 'cw721_tx.contract_address',
          from: 'cw721_contract.address',
        },
      },
    };
  }
}
