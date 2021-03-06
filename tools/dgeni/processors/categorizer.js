const _ = require('lodash');

/**
 * 黑名单
 */
const SELECTOR_BLACKLIST = new Set([

]);

/**
 * Processor to add properties to docs objects.
 *
 * isMethod     | Whether the doc is for a method on a class.
 * isDirective  | Whether the doc is for a @Component or a @Directive
 * isService    | Whether the doc is for an @Injectable
 * isNgModule   | Whether the doc is for an NgModule
 */
module.exports = function categorizer() {
    return {
        $runBefore: ['docs-processed'],
        $process: function(docs) {
            docs.filter(doc => ~['class', 'interface', 'type'].indexOf(doc.docType)).forEach(doc => decorateClassDoc(doc));
        }
    };

    /**
     * Decorates all class docs inside of the dgeni pipeline.
     * - Methods and properties of a class-doc will be extracted into separate variables.
     * - Identifies directives, services or NgModules and marks them them in class-doc.
     */
    function decorateClassDoc(classDoc) {
        classDoc.isConfig = _.endsWith(classDoc.name, 'Config');
        // Resolve all methods and properties from the classDoc. Includes inherited docs.
        classDoc.methods = resolveMethods(classDoc);
        classDoc.properties = resolveProperties(classDoc);

        // Call decorate hooks that can modify the method and property docs.
        classDoc.methods.forEach(doc => decorateMethodDoc(doc));
        classDoc.properties.forEach(doc => decoratePropertyDoc(doc));

        decoratePublicDoc(classDoc.properties);

        // Categorize the current visited classDoc into its Angular type.
        if (isDirective(classDoc)) {
            classDoc.isDirective = true;
            classDoc.directiveExportAs = getMetadataProperty(classDoc, 'exportAs');
            classDoc.directiveSelectors = getDirectiveSelectors(classDoc);
        } else if (isService(classDoc)) {
            classDoc.isService = true;
            classDoc.isConfig = _.endsWith(classDoc.name, 'Config');
        } else if (isNgModule(classDoc)) {
            classDoc.isNgModule = true;
        }

        // 过滤由于使用input&output组合，导致重复问题
        classDoc.properties = _.uniqBy(classDoc.properties, 'name');

        for (let i = 0, len = classDoc.properties.length; i < len; i++) {
            let pi = classDoc.properties[i];
            if (pi) isTwoWays(pi, classDoc.properties);
        }

        // 当使用是directiveInputAlias则去除引号
        classDoc.properties.forEach(p => {
            if (p.directiveInputAlias && p.directiveInputAlias.length > 1)
                p.directiveInputAlias = p.directiveInputAlias.substr(1, p.directiveInputAlias.length - 2);

            if (p.directiveOutputAlias && p.directiveOutputAlias.length > 1)
                p.directiveOutputAlias = p.directiveOutputAlias.substr(1, p.directiveOutputAlias.length - 2);
        });
    }

    function isTwoWays(doc, list) {
        doc.isTwoWays = false;
        let changeIdx = _.findIndex(list, function(p) {
            if (!p) return false;
            return p.name === doc.name + 'Change';
        });
        if (changeIdx === -1) return;
        doc.isTwoWays = true;
        delete list[changeIdx];
    }

    /**
     * Method that will be called for each method doc. The parameters for the method-docs
     * will be normalized, so that they can be easily used inside of dgeni templates.
     */
    function decorateMethodDoc(methodDoc) {
        normalizeMethodParameters(methodDoc);
        decoratePublicDoc(methodDoc);

        // Mark methods with a `void` return type so we can omit show the return type in the docs.
        methodDoc.showReturns = methodDoc.returnType && methodDoc.returnType != 'void';
    }

    /**
     * Method that will be called for each property doc. Properties that are Angular inputs or
     * outputs will be marked. Aliases for the inputs or outputs will be stored as well.
     */
    function decoratePropertyDoc(propertyDoc) {
        decoratePublicDoc(propertyDoc);

        propertyDoc.isDirectiveInput = isDirectiveInput(propertyDoc);
        propertyDoc.directiveInputAlias = getDirectiveInputAlias(propertyDoc);

        propertyDoc.isDirectiveOutput = isDirectiveOutput(propertyDoc);
        propertyDoc.directiveOutputAlias = getDirectiveOutputAlias(propertyDoc);

        // 检查是否复杂类型
        propertyDoc.isReturnConfig = _.endsWith(propertyDoc.returnType, 'Config');
        propertyDoc.isReturnUserDef = _.endsWith(propertyDoc.returnType, 'Type');
        if (propertyDoc.isReturnUserDef) {
            switch (propertyDoc.returnType) {
                case 'ButtonType':
                    propertyDoc.userDef = 'default,primary,warn';
                    break;
                case 'SkinType':
                    propertyDoc.userDef = 'ios,android,auto';
                    break;
            }
        }
    }

    /**
     * Decorates public exposed docs. Creates a property on the doc that indicates whether
     * the item is deprecated or not.
     **/
    function decoratePublicDoc(doc) {
        doc.isDeprecated = isDeprecatedDoc(doc);
    }
};

/** Function that walks through all inherited docs and collects public methods. */
function resolveMethods(classDoc) {
    let methods = classDoc.members.filter(member => member.hasOwnProperty('parameters'));

    if (classDoc.inheritedDoc) {
        methods = methods.concat(resolveMethods(classDoc.inheritedDoc));
    }

    return methods.filter(item => !item.name.startsWith('_'));
}

/** Function that walks through all inherited docs and collects public properties. */
function resolveProperties(classDoc) {
    let properties = classDoc.members.filter(member => !member.hasOwnProperty('parameters'));

    if (classDoc.inheritedDoc) {
        properties = properties.concat(resolveProperties(classDoc.inheritedDoc));
    }

    return properties.filter(item => !item.name.startsWith('_'));
}


/**
 * The `parameters` property are the parameters extracted from TypeScript and are strings
 * of the form "propertyName: propertyType" (literally what's written in the source).
 *
 * The `params` property is pulled from the `@param` JsDoc tag. We need to merge
 * the information of these to get name + type + description.
 *
 * We will use the `params` property to store the final normalized form since it is already
 * an object.
 */
function normalizeMethodParameters(method) {
    if (method.parameters) {
        method.parameters.forEach(parameter => {
            let [parameterName, parameterType] = parameter.split(':');

            // If the parameter is optional, the name here will contain a '?'. We store whether the
            // parameter is optional and remove the '?' for comparison.
            let isOptional = false;
            if (parameterName.includes('?')) {
                isOptional = true;
                parameterName = parameterName.replace('?', '');
            }

            if (!method.params) {
                method.params = [];
            }

            let jsDocParam = method.params.find(p => p.name == parameterName);

            if (!jsDocParam) {
                jsDocParam = { name: parameterName };
                method.params.push(jsDocParam);
            }

            jsDocParam.type = parameterType.trim();
            jsDocParam.isOptional = isOptional;
        });
    }
}

function isDirective(doc) {
    return hasClassDecorator(doc, 'Component') || hasClassDecorator(doc, 'Directive');
}

function isService(doc) {
    return hasClassDecorator(doc, 'Injectable')
}

function isNgModule(doc) {
    return hasClassDecorator(doc, 'NgModule');
}

function isDirectiveOutput(doc) {
    return hasMemberDecorator(doc, 'Output');
}

function isDirectiveInput(doc) {
    return hasMemberDecorator(doc, 'Input');
}

function isDeprecatedDoc(doc) {
    return (doc.tags && doc.tags.tags ||  []).some(tag => tag.tagName === 'deprecated');
}

function getDirectiveInputAlias(doc) {
    return isDirectiveInput(doc) ? doc.decorators.find(d => d.name == 'Input').arguments[0] : '';
}

function getDirectiveOutputAlias(doc) {
    return isDirectiveOutput(doc) ? doc.decorators.find(d => d.name == 'Output').arguments[0] : '';
}

function getDirectiveSelectors(classDoc) {
    const directiveSelectors = getMetadataProperty(classDoc, 'selector');

    if (directiveSelectors) {
        // Filter blacklisted selectors and remove line-breaks in resolved selectors.
        return directiveSelectors.replace(/[\r\n]/g, '').split(/\s*,\s*/)
            .filter(s => s !== '' && !s.includes('mat') && !SELECTOR_BLACKLIST.has(s));
    }
}

function getMetadataProperty(doc, property) {
    const metadata = doc.decorators
        .find(d => d.name === 'Component' || d.name === 'Directive').arguments[0];

    // Use a Regex to determine the given metadata property. This is necessary, because we can't
    // parse the JSON due to environment variables inside of the JSON (e.g module.id)
    let matches = new RegExp(`${property}s*:\\s*(?:"|'|\`)((?:.|\\n|\\r)+?)(?:"|'|\`)`)
        .exec(metadata);

    return matches && matches[1].trim();
}

function hasMemberDecorator(doc, decoratorName) {
    return doc.docType == 'member' && hasDecorator(doc, decoratorName);
}

function hasClassDecorator(doc, decoratorName) {
    return doc.docType == 'class' && hasDecorator(doc, decoratorName);
}

function hasDecorator(doc, decoratorName) {
    return doc.decorators &&
        doc.decorators.length &&
        doc.decorators.some(d => d.name == decoratorName);
}
