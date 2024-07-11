import Knex, { Knex as IKnex } from 'knex';
import knexConfig from '../../../knexfile';

const environment = process.env.NODE_ENV || 'development';
const cfg = knexConfig[environment];
const knex = Knex(cfg);

export default knex;

export async function batchUpdate(
  trx: IKnex.Transaction,
  tableName: string,
  records: any,
  fields: string[]
) {
  if (records.length === 0) return;
  const stringListUpdates = records
    .map((record: any) => {
      const values = fields.map((field) =>
        record[field] !== undefined ? `'${record[field]}'` : 'NULL'
      );
      return `(${record.id}, ${values.join(', ')})`;
    })
    .join(',');
  const query = `
      UPDATE ${tableName}
      SET ${fields.map((field) => `${field} = temp.${field}`).join(', ')}
      FROM (VALUES ${stringListUpdates}) AS temp(id, ${fields.join(', ')})
      WHERE temp.id = ${tableName}.id
    `;
  await trx.raw(query);
}
