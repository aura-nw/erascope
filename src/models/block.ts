import { Model } from 'objection';
import BaseModel from './base';
import BlockSignature from './block_signature';
import Transaction from './transaction';

export default class Block extends BaseModel {
  height!: number;

  hash!: string;

  time!: Date;

  proposer_address!: string;

  data!: JSON;

  static get tableName() {
    return 'block';
  }

  static get jsonAttributes() {
    return ['data'];
  }

  static get idColumn(): string | string[] {
    return 'height';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['height', 'hash', 'time', 'proposer_address', 'data'],
      properties: {
        height: { type: 'number' },
        hash: { type: 'string', minLength: 1, maxLength: 255 },
        time: { type: 'string', format: 'date-time' },
        proposer_address: { type: 'string', minLength: 1, maxLength: 255 },
      },
    };
  }

  static get relationMappings() {
    return {
      signatures: {
        relation: Model.HasManyRelation,
        modelClass: BlockSignature,
        join: {
          from: 'block.height',
          to: 'block_signature.height',
        },
      },
      txs: {
        relation: Model.HasManyRelation,
        modelClass: Transaction,
        join: {
          from: 'block.height',
          to: 'transaction.height',
        },
      },
    };
  }
}
