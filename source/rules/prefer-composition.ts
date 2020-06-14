/**
 * @license Use of this source code is governed by an MIT-style license that
 * can be found in the LICENSE file at https://github.com/cartant/eslint-plugin-rxjs-angular
 */

import { TSESTree as es } from "@typescript-eslint/experimental-utils";
import { stripIndent } from "common-tags";
import {
  getParent,
  getTypeServices,
  isAssignmentExpression,
  isCallExpression,
  isIdentifier,
  isMemberExpression,
  isVariableDeclarator,
} from "eslint-etc";
import { ruleCreator } from "../utils";

const defaultOptions: {
  checkDecorators?: string[];
}[] = [];

const rule = ruleCreator({
  defaultOptions,
  meta: {
    docs: {
      category: "Best Practices",
      description:
        "Forbids `subscribe` calls that are not composed within Angular components (and, optionally, within services, directives, and pipes).",
      recommended: false,
    },
    fixable: null,
    messages: {
      notComposed: "Subscription not composed.",
      notDeclared: "Composed subscription `{{name}}` not a class property.",
      notImplemented: "`ngOnDestroy` not implemented.",
      notUnsubscribed: "Composed subscription not unsubscribed.",
    },
    schema: [
      {
        properties: {
          checkDecorators: { type: "array", items: { type: "string" } },
        },
        type: "object",
        description: stripIndent`
        An optional object with an optional \`checkDecorators\` property.
        The \`checkDecorators\` property is an array containing the names of the decorators that determine whether or not a class is checked.
      `,
      },
    ],
    type: "problem",
  },
  name: "prefer-composition",
  create: (context, unused: typeof defaultOptions) => {
    const { couldBeObservable, couldBeSubscription } = getTypeServices(context);
    const [{ checkDecorators = ["Component"] } = {}] = context.options;

    type Entry = {
      addCallExpressions: es.CallExpression[];
      classDeclaration: es.ClassDeclaration;
      classProperties: es.ClassProperty[];
      hasDecorator: boolean;
      ngOnDestroyDefinition?: es.MethodDefinition;
      subscribeCallExpressions: es.CallExpression[];
      subscriptions: Set<string>;
      unsubscribeCallExpressions: es.CallExpression[];
    };
    const entries: Entry[] = [];

    function checkEntry(record: Entry) {
      const {
        classDeclaration,
        classProperties,
        ngOnDestroyDefinition,
        subscribeCallExpressions,
        subscriptions,
        unsubscribeCallExpressions,
      } = record;

      if (subscribeCallExpressions.length === 0) {
        return;
      }
      subscribeCallExpressions.forEach((callExpression) => {
        const { callee } = callExpression;
        if (isMemberExpression(callee)) {
          const { object, property } = callee;
          if (!couldBeObservable(object)) {
            return;
          }
          if (isComposed(callExpression, record)) {
            return;
          }
          context.report({
            messageId: "notComposed",
            node: property,
          });
        }
      });

      if (!ngOnDestroyDefinition) {
        context.report({
          messageId: "notImplemented",
          node: classDeclaration.id,
        });
        return;
      }

      subscriptions.forEach((subscription) => {
        const classProperty = classProperties.find(
          (classProperty: any) => classProperty.key.name === subscription
        );
        if (!classProperty) {
          context.report({
            data: { name: subscription },
            messageId: "notDeclared",
            node: classDeclaration.id,
          });
          return;
        }

        const callExpression = unsubscribeCallExpressions.find(
          (callExpression) => {
            const name = getMethodCalleeName(callExpression);
            return name === subscription;
          }
        );
        if (!callExpression) {
          context.report({
            data: { name: subscription },
            messageId: "notUnsubscribed",
            node: classProperty.key,
          });
          return;
        }
      });
    }

    function getEntry() {
      const { length, [length - 1]: entry } = entries;
      return entry;
    }

    function getMethodCalleeName(callExpression: es.CallExpression) {
      const { callee } = callExpression;
      if (isMemberExpression(callee)) {
        const { object } = callee;
        if (isMemberExpression(object) && isIdentifier(object.property)) {
          return object.property.name;
        }
        if (isIdentifier(object)) {
          return object.name;
        }
      }
      return undefined;
    }

    function getMethodCalleeObject(callExpression: es.CallExpression) {
      const { callee } = callExpression;
      if (isMemberExpression(callee)) {
        return callee.object;
      }
      return undefined;
    }

    function hasDecorator(node: es.ClassDeclaration) {
      const { decorators } = node as any;
      return (
        decorators &&
        decorators.some((decorator: any) => {
          const { expression } = decorator;
          if (!isCallExpression(expression)) {
            return false;
          }
          if (!isIdentifier(expression.callee)) {
            return false;
          }
          const { name } = expression.callee;
          return checkDecorators.some((check: string) => name === check);
        })
      );
    }

    function isComposed(callExpression: es.CallExpression, entry: Entry) {
      // A call to subscribe is composed if it's directly added to a
      // subscription or if it's assigned to a variable that is added to a
      // subscription.
      const { addCallExpressions, subscriptions } = entry;
      const parent = getParent(callExpression);
      if (isCallExpression(parent)) {
        const addCallExpression = addCallExpressions.find(
          (callExpression) => callExpression === parent
        );
        if (!addCallExpression) {
          return false;
        }
        const object = getMethodCalleeObject(addCallExpression);
        if (!object || !couldBeSubscription(object)) {
          return false;
        }
        const name = getMethodCalleeName(addCallExpression);
        if (!name) {
          return false;
        }
        subscriptions.add(name);
        return true;
      }
      if (isVariableDeclarator(parent) && isIdentifier(parent.id)) {
        return isVariableComposed(parent.id, entry);
      }
      if (
        isAssignmentExpression(parent) &&
        isIdentifier(parent.left) &&
        parent.operator === "="
      ) {
        return isVariableComposed(parent.left, entry);
      }
      return false;
    }

    function isVariableComposed(identifier: es.Identifier, entry: Entry) {
      // A subscription variable is composed if it's added to another
      // subscription.
      const { name } = identifier;
      const { addCallExpressions, subscriptions } = entry;
      const addCallExpression = addCallExpressions.find(
        (callExpression) => getMethodCalleeName(callExpression) === name
      );
      if (!addCallExpression) {
        return false;
      }
      const object = getMethodCalleeObject(addCallExpression);
      if (!object || !couldBeSubscription(object)) {
        return false;
      }
      subscriptions.add(name);
      return true;
    }

    return {
      "CallExpression[callee.property.name='add']": (
        node: es.CallExpression
      ) => {
        const entry = getEntry();
        if (entry && entry.hasDecorator) {
          entry.addCallExpressions.push(node);
        }
      },
      "CallExpression[callee.property.name='subscribe']": (
        node: es.CallExpression
      ) => {
        const entry = getEntry();
        if (entry && entry.hasDecorator) {
          entry.subscribeCallExpressions.push(node);
        }
      },
      ClassDeclaration: (node: es.ClassDeclaration) => {
        entries.push({
          addCallExpressions: [],
          classDeclaration: node,
          classProperties: [],
          hasDecorator: hasDecorator(node),
          subscribeCallExpressions: [],
          subscriptions: new Set<string>(),
          unsubscribeCallExpressions: [],
        });
      },
      "ClassDeclaration:exit": (node: es.ClassDeclaration) => {
        const entry = entries.pop();
        if (entry && entry.hasDecorator) {
          checkEntry(entry);
        }
      },
      ClassProperty: (node: es.ClassProperty) => {
        const entry = getEntry();
        if (entry && entry.hasDecorator) {
          entry.classProperties.push(node);
        }
      },
      "MethodDefinition[key.name='ngOnDestroy'][kind='method']": (
        node: es.MethodDefinition
      ) => {
        const entry = getEntry();
        if (entry && entry.hasDecorator) {
          entry.ngOnDestroyDefinition = node;
        }
      },
      "MethodDefinition[key.name='ngOnDestroy'][kind='method'] CallExpression[callee.property.name='unsubscribe']": (
        node: es.CallExpression
      ) => {
        const entry = getEntry();
        if (entry && entry.hasDecorator) {
          entry.unsubscribeCallExpressions.push(node);
        }
      },
    };
  },
});

export = rule;
