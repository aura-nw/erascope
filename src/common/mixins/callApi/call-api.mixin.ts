import { Service, ServiceSchema } from 'moleculer';
import axios from 'axios';
import { Config } from '../../index';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const resilient = require('resilient');

export default class CallApiMixin
  implements Partial<ServiceSchema>, ThisType<Service>
{
  private _schema: Partial<ServiceSchema> & ThisType<Service>;

  public constructor() {
    // eslint-disable-next-line no-underscore-dangle
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
              const resilientClient = resilient({
                service: { basePath: '/', retry },
              });
              this.callApiClient = resilientClient;
            }
          }

          // Set domain
          if (this.settings.enableLoadBalancer === 'false') {
            // eslint-disable-next-line prefer-destructuring
            this.callApiClient.defaults.baseURL = domain[0];
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
          const result = await callApiClient.get(path);
          if (result.status === 200) {
            if (result.data) {
              return result.data;
            }
            return null;
          }
          throw new Error(
            `Call api ${domain[0]}/${path} fail with status = ${result.status}`
          );
        },
      },
    };
  }

  public start() {
    // eslint-disable-next-line no-underscore-dangle
    return this._schema;
  }
}

export const callApiMixin = new CallApiMixin().start();
