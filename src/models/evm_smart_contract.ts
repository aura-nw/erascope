import BaseModel from './base';

export class EVMSmartContract extends BaseModel {
  id!: number;

  created_at!: Date;

  updated_at!: Date;

  address!: string;

  creator!: string;

  created_height!: number;

  created_hash!: string;

  type!: string;

  static get tableName() {
    return 'evm_smart_contract';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string' },
      },
    };
  }

  $beforeInsert() {
    this.created_at = new Date();
    this.updated_at = this.created_at;
  }

  $beforeUpdate() {
    this.updated_at = new Date();
  }
}
