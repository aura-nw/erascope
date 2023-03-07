import BaseModel from './base';

export interface ICW20Holder {
  id?: number;
  address: string;
  balance: number;
  contract_address: string;
  created_at?: Date;
  updated_at?: Date;
}
export class CW20Holder extends BaseModel implements ICW20Holder {
  id?: number;

  contract_address!: string;

  address!: string;

  balance!: number;

  created_at?: Date;

  updated_at?: Date;

  static get tableName() {
    return 'cw20_holder';
  }

  static get jsonSchema() {
    return {
      type: 'object',
      required: ['balance', 'contract_address', 'address'],
      properties: {
        contract_address: { type: 'string' },
        address: { type: 'string' },
        balance: { type: 'number' },
      },
    };
  }
}
