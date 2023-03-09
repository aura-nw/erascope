import { Service, ServiceSchema } from 'moleculer';
import axios from 'axios';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import * as resilient from 'resilient';
import { Config } from '../../common';

export default class CallApiMixin
  implements Partial<ServiceSchema>, ThisType<Service>
{
  private _schema: Partial<ServiceSchema> & ThisType<Service>;

  public constructor() {
    this._schema = {
      settings: {
        enableLoadBalancer: Config.ENABLE_LOADBALANCER,
      },
      methods: {
        async getCallApiClient(
          domain: string[],
          retry = Config.RETRY_DEFAULT_CALL_API
        ) {
          // Create client
          if (this.callApiClient === undefined) {
            if (this.settings.enableLoadBalancer === 'false') {
              const axiosClient = axios.create({});
              this.callApiClient = axiosClient;
            } else {
              const resilientClient = resilient.default({
                service: { basePath: '/', retry },
              });
              this.callApiClient = resilientClient;
            }
          }

          // Set domain
          if (this.settings.enableLoadBalancer === 'false') {
            [this.callApiClient.defaults.baseURL] = domain;
          } else {
            this.callApiClient.setServers(domain);
            // This.callApiClient.serviceOptions.retry = retry;
          }

          return this.callApiClient;
        },
        async callApiFromDomain(
          domain: string[],
          path: string,
          retry = Config.RETRY_DEFAULT_CALL_API
        ) {
          const callApiClient = await this.getCallApiClient(domain, retry);
          try {
            const result = await callApiClient.get(path);
            if (result.data) {
              return result.data;
            }
            return null;
          } catch (error) {
            this.logger.error(error);
            return null;
          }
        },
      },
    };
  }

  public start() {
    return this._schema;
  }
}

export const callApiMixin = new CallApiMixin().start();
