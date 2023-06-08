import { fromBech32 } from '@cosmjs/encoding';
import _ from 'lodash';

export default class Utils {
  public static isValidAddress(address: string, length = -1) {
    try {
      const decodeResult = fromBech32(address);
      if (length === -1) {
        return true;
      }
      if (decodeResult.data.length === length) {
        return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  public static isValidAccountAddress(
    address: string,
    prefix: string,
    length = -1
  ) {
    try {
      const decodeResult = fromBech32(address);
      if (length === -1) {
        return true;
      }
      if (
        decodeResult.data.length === length &&
        decodeResult.prefix === prefix
      ) {
        return true;
      }
    } catch (error) {
      return false;
    }
    return false;
  }

  public static flattenObject(obj: any): any {
    return Object.keys(obj).reduce((acc, k) => {
      if (
        typeof obj[k] === 'object' &&
        !Array.isArray(obj[k]) &&
        obj[k] &&
        k !== 'pub_key'
      )
        Object.assign(acc, Utils.flattenObject(obj[k]));
      else acc[k] = obj[k];
      return acc;
    }, {});
  }

  public static camelizeKeys(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map((v: any) => this.camelizeKeys(v));
    }
    if (obj != null && obj.constructor === Object) {
      return Object.keys(obj).reduce(
        (result, key) => ({
          ...result,
          [key === '@type' ? '@type' : _.snakeCase(key)]: this.camelizeKeys(
            obj[key]
          ),
        }),
        {}
      );
    }
    return obj;
  }

  public static getDepth(obj: any): number {
    let depth = 0;
    if (obj.children) {
      obj.children.forEach((d: any) => {
        const tmpDepth = this.getDepth(d);
        if (tmpDepth > depth) depth = tmpDepth;
      });
    }
    return 1 + depth;
  }
}
