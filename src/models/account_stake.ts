/* eslint-disable import/no-cycle */
import { Model } from 'objection';
import { Account } from './account';
import BaseModel from './base';
import { Validator } from './validator';

export class AccountStake extends BaseModel {
  id!: number;

  account_id!: number;

  validator_src_id!: number;

  validator_dst_id: number | undefined;

  type!: string;

  balance!: string;

  end_time: string | undefined;

  static get tableName() {
    return 'account_stake';
  }

  static get TYPES() {
    return {
      DELEGATE: 'delegate',
      REDELEGATE: 'redelegate',
      UNBOND: 'unbond',
    };
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['account_id', 'validator_src_id', 'balance'],
      properties: {
        account_id: { type: 'number' },
        validator_src_id: { type: 'number' },
        validator_dst_id: { type: ['number', 'null'] },
        type: { type: 'string', enum: Object.values(this.TYPES) },
        balance: { type: 'string' },
        end_time: { type: ['string', 'null'], format: 'date-time' },
      },
    };
  }

  static get relationMappings() {
    return {
      account: {
        relation: Model.BelongsToOneRelation,
        modelClass: Account,
        join: {
          from: 'account_stake.account_id',
          to: 'account.id',
        },
      },
      src_validator: {
        relation: Model.BelongsToOneRelation,
        modelClass: Validator,
        join: {
          from: 'account_stake.validator_src_id',
          to: 'validator.id',
        },
      },
      dst_validator: {
        relation: Model.BelongsToOneRelation,
        modelClass: Validator,
        join: {
          from: 'account_stake.validator_dst_id',
          to: 'validator.id',
        },
      },
    };
  }
}
