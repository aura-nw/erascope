import { AfterAll, BeforeAll, Describe, Test } from '@jest-decorated/core';
import { ServiceBroker } from 'moleculer';
import GraphiQLService from '../../../../src/services/api-gateways/graphiql.service';
import { ResponseDto } from '../../../../src/common/types/response-api';
import { ErrorCode, ErrorMessage } from '../../../../src/common/types/errors';
import config from '../../../../config.json' assert { type: 'json' };

@Describe('Test graphiql api service')
export default class GraphiQLTest {
  broker = new ServiceBroker({ logger: false });

  graphiqlService?: GraphiQLService;

  @BeforeAll()
  async initSuite() {
    await this.broker.start();
    this.graphiqlService = this.broker.createService(
      GraphiQLService
    ) as GraphiQLService;
  }

  @AfterAll()
  async tearDown() {
    await this.broker.stop();
  }

  @Test('Query success')
  public async testQuerySuccess() {
    const result: ResponseDto = await this.broker.call(
      'v1.graphiql.handleGraphQLQuery',
      {
        operationName: 'MyQuery',
        query:
          'query MyQuery { auratestnet { block { hash height proposer_address transactions { code codespace event_attributes { key value } } } } }',
        variables: {},
      }
    );

    expect(result?.code).toEqual(ErrorCode.SUCCESSFUL);
    expect(result?.message).toEqual(ErrorMessage.SUCCESSFUL);
  }

  @Test('Invalid query format')
  public async testInvalidQueryFormat() {
    const result: ResponseDto = await this.broker.call(
      'v1.graphiql.handleGraphQLQuery',
      {
        operationName: 'MyQuery',
        query: 'abc',
        variables: {},
      }
    );

    expect(result?.code).toEqual(ErrorCode.WRONG);
    expect(result?.message).toEqual(ErrorMessage.VALIDATION_ERROR);
    expect(result?.data).toEqual('Invalid query');
  }

  @Test('Invalid mutation operation')
  public async testInvalidMutationOperation() {
    const result: ResponseDto = await this.broker.call(
      'v1.graphiql.handleGraphQLQuery',
      {
        operationName: 'MyMutation',
        query:
          'mutation MyMutation($code: Int = 1) { auratestnet { update_code(where: {code_id: {_eq: $code}}) { affected_rows } } }',
        variables: {},
      }
    );

    expect(result?.code).toEqual(ErrorCode.WRONG);
    expect(result?.message).toEqual(ErrorMessage.VALIDATION_ERROR);
    expect(result?.data).toEqual(
      'This Horoscope GraphiQL service only allows query operations'
    );
  }

  @Test('Query depth exceed limit')
  public async testQueryDepthExceedLimit() {
    const result: ResponseDto = await this.broker.call(
      'v1.graphiql.handleGraphQLQuery',
      {
        operationName: 'MyQuery',
        query:
          'query MyQuery { auratestnet { block { transactions { events { event_attributes { composite_key } } } } } }',
        variables: {},
      }
    );

    expect(result?.code).toEqual(ErrorCode.WRONG);
    expect(result?.message).toEqual(ErrorMessage.VALIDATION_ERROR);
    expect(result?.data).toEqual(
      `The query depth must not be greater than ${config.graphiqlApi.depthLimit}`
    );
  }

  @Test('Query root where depth exceed limit')
  public async testQueryRootWhereDepthExceedLimit() {
    const result: ResponseDto = await this.broker.call(
      'v1.graphiql.handleGraphQLQuery',
      {
        operationName: 'MyQuery',
        query:
          'query MyQuery { auratestnet { block(where: {transactions: {events: {event_attributes: {id: {_eq: 1}}}}}) { transactions { id } } } }',
        variables: {},
      }
    );

    expect(result?.code).toEqual(ErrorCode.WRONG);
    expect(result?.message).toEqual(ErrorMessage.VALIDATION_ERROR);
    expect(result?.data).toEqual(
      `The root where query depth must not be greater than ${config.graphiqlApi.rootWhereDepthLimit}`
    );
  }

  @Test('Query sub where depth exceed limit')
  public async testQuerySubWhereDepthExceedLimit() {
    const result: ResponseDto = await this.broker.call(
      'v1.graphiql.handleGraphQLQuery',
      {
        operationName: 'MyQuery',
        query:
          'query MyQuery { auratestnet { block { transactions(where: {events: {event_attributes: {id: {_eq: 1}}}}) { id } } } }',
        variables: {},
      }
    );

    expect(result?.code).toEqual(ErrorCode.WRONG);
    expect(result?.message).toEqual(ErrorMessage.VALIDATION_ERROR);
    expect(result?.data).toEqual(
      `The sub where query depth must not be greater than ${config.graphiqlApi.subWhereDepthLimit}`
    );
  }
}
