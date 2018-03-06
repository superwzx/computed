//
// Computed Observable Values
//
// (before tko, `computed` was also known as `dependentObservable`)
//
import {
    createSymbolOrString,
    objectForEach,
    options as koOptions,
    safeSetTimeout,
    hasPrototype,
} from 'tko.utils';

import {
    dependencyDetection,
    valuesArePrimitiveAndEqual,
    observable,
    subscribable
} from 'tko.observable';


var computedState = createSymbolOrString('_state');

export function computed(evaluatorFunctionOrOptions, evaluatorFunctionTarget, options) {
    if (typeof evaluatorFunctionOrOptions === "object") {
        // Single-parameter syntax - everything is on this "options" param
        options = evaluatorFunctionOrOptions;
    } else {
        // Multi-parameter syntax - construct the options according to the params passed
        options = options || {};
        if (evaluatorFunctionOrOptions) {
            options.read = evaluatorFunctionOrOptions;
        }
    }
    if (typeof options.read != "function")
        throw Error("Pass a function that returns the value of the computed");

    var writeFunction = options.write;
    var state = {
        latestValue: undefined,
        isStale: true,  //stale：旧的
        isBeingEvaluated: false,
        suppressDisposalUntilDisposeWhenReturnsFalse: false,  // suppress：抑制，禁止  disposal：n.处理  dispose：vt.处理；  禁止处理， 直到处理返回错误
        isDisposed: false,
        readFunction: options.read,
        evaluatorFunctionTarget: evaluatorFunctionTarget || options.owner,  // 求值函数目标
        dependencyTracking: {},
        dependenciesCount: 0,
        evaluationTimeoutInstance: null  // 求值超时程序
    };

    function computedObservable() {
        if (arguments.length > 0) {
            if (typeof writeFunction === "function") {
                // Writing a value
                writeFunction.apply(state.evaluatorFunctionTarget, arguments);
            } else {
                throw new Error("Cannot write a value to a computed unless you specify a 'write' option. If you wish to read the current value, don't pass any parameters.");
            }
            return this; // Permits chained assignments
        } else {
            // Reading the value
            dependencyDetection.registerDependency(computedObservable);
            if (state.isStale) {
                // 立即求值
                computedObservable.evaluateImmediate();
            }

            return state.latestValue;
        }
    }
    //
    computedObservable[computedState] = state;
    // 是否有重写函数
    computedObservable.hasWriteFunction = typeof writeFunction === "function";


    // 调用subscribable.fn.init方法,
    // 使computedObservable增加_subscriptions,_versionNumber这两个属性
    subscribable.fn.init(computedObservable);

    Object.setPrototypeOf(computedObservable, computed.fn)


    // Evaluate, unless sleeping or deferEvaluation is true
    // 求职,除非处在sleeping状态,或者deferEvaluation状态
    if (!options.deferEvaluation) {
        computedObservable.evaluateImmediate();
    }


    // 返回computedObservable
    return computedObservable;
}


// Utility function that disposes a given dependencyTracking entry
function computedDisposeDependencyCallback(id, entryToDispose) {
    if (entryToDispose !== null && entryToDispose.dispose) {
        entryToDispose.dispose();
    }
}

// This function gets called each time a dependency is detected while evaluating a computed.
// It's factored out as a shared function to avoid creating unnecessary function instances during evaluation.
function computedBeginDependencyDetectionCallback(subscribable, id) {
    var computedObservable = this.computedObservable,
        state = computedObservable[computedState];
    if (!state.isDisposed) {
        if (this.disposalCount && this.disposalCandidates[id]) {
            // Don't want to dispose this subscription, as it's still being used
            computedObservable.addDependencyTracking(id, subscribable, this.disposalCandidates[id]);
            this.disposalCandidates[id] = null; // No need to actually delete the property - disposalCandidates is a transient object anyway
            --this.disposalCount;
        } else if (!state.dependencyTracking[id]) {
            // Brand new subscription - add it
            computedObservable.addDependencyTracking(id, subscribable, computedObservable.subscribeToDependency(subscribable));
        }
    }
}


// prototype
computed.fn = {
    equalityComparer: valuesArePrimitiveAndEqual,  // 相等比较器
    // 获取依赖的数量
    getDependenciesCount: function () {
        return this[computedState].dependenciesCount;
    },

    /**
     * 添加依赖项跟踪
     * @param id
     * @param target
     * @param trackingObj
     */
    addDependencyTracking: function (id, target, trackingObj) {
        this[computedState].dependencyTracking[id] = trackingObj;
        trackingObj._order = this[computedState].dependenciesCount++;
        trackingObj._version = target.getVersion();
    },


    /**
     * 检测依赖是否改变
     * @returns {boolean}
     */
    haveDependenciesChanged: function () {
        var id,
            dependency,
            dependencyTracking = this[computedState].dependencyTracking;
        for (id in dependencyTracking) {
            if (dependencyTracking.hasOwnProperty(id)) {
                dependency = dependencyTracking[id];
                if (dependency._target.hasChanged(dependency._version)) {
                    return true;
                }
            }
        }
    },

    // 污迹
    markDirty: function () {
        // Process "dirty" events if we can handle delayed notifications
        // 处理“脏”事件，如果我们能够处理延迟通知
        if (this._evalDelayed && !this[computedState].isBeingEvaluated) {
            this._evalDelayed();
        }
    },
    // 是否有效
    isActive: function () {
        return this[computedState].isStale || this[computedState].dependenciesCount > 0;
    },

    // 响应变化
    respondToChange: function () {
        // Ignore "change" events if we've already scheduled a delayed notification
        if (!this._notificationIsPending) {
            this.evaluatePossiblyAsync();
        }
    },

    // 订阅的依赖
    subscribeToDependency: function (target) {
        return target.subscribe(this.evaluatePossiblyAsync, this);
    },

    // 异步求值
    evaluatePossiblyAsync: function () {
        var computedObservable = this,
            throttleEvaluationTimeout = computedObservable.throttleEvaluation;
        if (throttleEvaluationTimeout && throttleEvaluationTimeout >= 0) {
            clearTimeout(this[computedState].evaluationTimeoutInstance);
            this[computedState].evaluationTimeoutInstance = safeSetTimeout(function () {
                computedObservable.evaluateImmediate(true /*notifyChange*/);
            }, throttleEvaluationTimeout);
        } else if (computedObservable._evalDelayed) {
            computedObservable._evalDelayed();
        } else {
            computedObservable.evaluateImmediate(true /*notifyChange*/);
        }
    },

    // 立即求值
    evaluateImmediate: function (notifyChange) {
        var computedObservable = this,
            state = computedObservable[computedState];

        if (state.isBeingEvaluated) {
            // If the evaluation of a ko.computed causes side effects, it's possible that it will trigger its own re-evaluation.
            // This is not desirable (it's hard for a developer to realise a chain of dependencies might cause this, and they almost
            // certainly didn't intend infinite re-evaluations). So, for predictability, we simply prevent ko.computeds from causing
            // their own re-evaluation. Further discussion at https://github.com/SteveSanderson/knockout/pull/387
            return;
        }

        // Do not evaluate (and possibly capture new dependencies) if disposed
        if (state.isDisposed) {
            return;
        }

        // It just did return false, so we can stop suppressing now
        state.suppressDisposalUntilDisposeWhenReturnsFalse = false;

        state.isBeingEvaluated = true;
        try {
            this.evaluateImmediate_CallReadWithDependencyDetection(notifyChange);
        } finally {
            state.isBeingEvaluated = false;
        }

        if (!state.dependenciesCount) {
            computedObservable.dispose();
        }
    },
    evaluateImmediate_CallReadWithDependencyDetection: function (notifyChange) {
        // This function is really just part of the evaluateImmediate logic. You would never call it from anywhere else.
        // Factoring it out into a separate function means it can be independent of the try/catch block in evaluateImmediate,  factoring: 分解  independent: 独立的
        // which contributes to saving about 40% off the CPU overhead of computed evaluation (on V8 at least).

        var computedObservable = this,
            state = computedObservable[computedState];

        // Initially, we assume that none of the subscriptions are still being used (i.e., all are candidates for disposal).
        // Then, during evaluation, we cross off any that are in fact still being used.
        var isInitial = !state.dependenciesCount,   // If we're evaluating when there are no previous dependencies, it must be the first time
            dependencyDetectionContext = {  // 依赖检测上下文
                computedObservable: computedObservable,
                disposalCandidates: state.dependencyTracking,  // disposal: n.处理  candidates：候选
                disposalCount: state.dependenciesCount
            };

        // 依赖检测 - 开始
        dependencyDetection.begin({
            callbackTarget: dependencyDetectionContext,  // 回调目标
            callback: computedBeginDependencyDetectionCallback,  // 回调
            computed: computedObservable,
            isInitial: isInitial
        });

        // 重置dependencyTracking和dependenciesCount
        state.dependencyTracking = {};
        state.dependenciesCount = 0;

        var newValue = this.evaluateImmediate_CallReadThenEndDependencyDetection(state, dependencyDetectionContext);

        if (computedObservable.isDifferent(state.latestValue, newValue)) {
            computedObservable.notifySubscribers(state.latestValue, "beforeChange");

            state.latestValue = newValue;

            if (notifyChange) {
                computedObservable.notifySubscribers(state.latestValue);
            }
        }

        if (isInitial) {
            computedObservable.notifySubscribers(state.latestValue, "awake");
        }
    },

    // 立即求值，调用ReadFunction，然后结束依赖检测
    evaluateImmediate_CallReadThenEndDependencyDetection: function (state, dependencyDetectionContext) {
        // This function is really part of the evaluateImmediate_CallReadWithDependencyDetection logic.
        // You'd never call it from anywhere else. Factoring it out means that evaluateImmediate_CallReadWithDependencyDetection
        // can be independent of try/finally blocks, which contributes to saving about 40% off the CPU
        // overhead of computed evaluation (on V8 at least).

        try {
            var readFunction = state.readFunction;
            return state.evaluatorFunctionTarget ? readFunction.call(state.evaluatorFunctionTarget) : readFunction();
        } finally {
            dependencyDetection.end();

            // For each subscription no longer being used, remove it from the active subscriptions list and dispose it
            if (dependencyDetectionContext.disposalCount) {
                objectForEach(dependencyDetectionContext.disposalCandidates, computedDisposeDependencyCallback);
            }

            state.isStale = false;
        }
    },

    peek: function () {
        // Peek won't re-evaluate, except while the computed is sleeping or to get the initial value when "deferEvaluation" is set.
        var state = this[computedState];
        if (state.isStale && !state.dependenciesCount) {
            this.evaluateImmediate();
        }
        return state.latestValue;
    },

    limit: function (limitFunction) {
        // Override the limit function with one that delays evaluation as well
        subscribable.fn.limit.call(this, limitFunction);
        this._evalDelayed = function () {
            this._limitBeforeChange(this[computedState].latestValue);

            this[computedState].isStale = true; // Mark as dirty

            // Pass the observable to the "limit" code, which will access it when
            // it's time to do the notification.
            this._limitChange(this);
        };
    },

    dispose: function () {
        var state = this[computedState];
        if (state.dependencyTracking) {
            objectForEach(state.dependencyTracking, function (id, dependency) {
                if (dependency.dispose)
                    dependency.dispose();
            });
        }

        state.dependencyTracking = null;
        state.dependenciesCount = 0;
        state.isDisposed = true;
        state.isStale = false;
        state.readFunction = null;
    }
};


// the inheritance chain is created manually in the ko.computed constructor
Object.setPrototypeOf(computed.fn, subscribable.fn)


// Set the proto chain values for ko.hasPrototype
const protoProp = observable.protoProperty; // == "__ko_proto__"
computed[protoProp] = observable;
computed.fn[protoProp] = computed;

export function isComputed(instance) {
    return hasPrototype(instance, computed);
}
