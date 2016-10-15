import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

import { Luis } from './luis-model';

export class LanguageModelParser {
    private doc: any = {};

    parse(files: string[], culture: string): Luis.Model {
        try {
            files.forEach(file => {
                // XXX Conflicting keys not supported. Multiple files could be merged together.
                let yamlFileContents = fs.readFileSync(file, 'utf8');
                Object.assign(this.doc, yaml.safeLoad(yamlFileContents));
            });
        } catch (e) {
            console.log('Not able to parse language model\nError: %s', e.message);
            process.exit(e.errno);
        }

        let luisModel: Luis.Model = {
            luis_schema_version: '1.3.0',
            name: 'tef',
            desc: 'Bot Model ' + new Date(),
            culture: culture,
            intents: [],
            entities: [],
            composites: [],
            bing_entities: [],
            actions: [],
            model_features: [],
            regex_features: [],
            utterances: []
        };

        let intents = Object.keys(this.doc);
        let invalidIntents = intents.some(intent => intent.length > 50);
        if (invalidIntents) {
            console.log('Not able to process intents longer than 50 characters');
            process.exit(1);
        }

        let entitiesMap = new Map<string, Luis.Entity>();

        intents = intents.filter(intent => !intent.startsWith('list.'));

        intents.forEach(intent => {
            let sentences = this.doc[intent];

            sentences = sentences.map((sentence: string) => this.expandVariables(sentence))
                                 .reduce((a: string[], b: string[]) => a.concat(b)); // flatten arrays

            sentences.forEach((sentence: string) => {
                let sentenceEntities = this.extractEntities(sentence);
                this.registerGlobalEntities(sentenceEntities, entitiesMap);

                let plainSentence = this.replaceRawEntityValues(sentence, sentenceEntities);

                let utterance = this.buildUtterance(plainSentence, intent, sentenceEntities);
                luisModel.utterances.push(utterance);
            });
        });

        luisModel.entities = Array.from(entitiesMap.values());
        luisModel.intents = intents.map(intent => <Luis.Intent>{name: intent});
        return luisModel;
    }

    private expandVariables(sentence: string): string[] {
        let sentenceEntities = this.extractEntities(sentence);
        let listEntities = sentenceEntities.filter(entity => entity.entityValue.startsWith('${')); // phraselist placeholder

        if (listEntities.length === 0) {
            return [sentence];
        }

        if (listEntities.length > 1) {
            console.log('Not able to process more than one variable in a sentence');
            process.exit(1);
        }

        let expandedSentences: string[] = [];
        listEntities.forEach(listEntity => {
            let listValues = this.doc['list.' + listEntity.entityValue];
            listValues.forEach((value: string) => {
                expandedSentences.push(sentence.replace(listEntity.entityValue, value));
            });
        });

        return expandedSentences;
    }

    private extractEntities(sentence: string): any[] {
        let regexEntity = /\[(.+?):(.+?)\]/g; // entities are tagged as [entityValue:entityType], ex. [Burgos:city]

        let entities: any[] = [];
        let match: RegExpExecArray;

        while (match = regexEntity.exec(sentence)) {
            let entityValue = match[1];
            let entityType = match[2];
            let entityEndIndex = regexEntity.lastIndex;
            let entityStartIndex = regexEntity.lastIndex - '[:]'.length - entityType.length - entityValue.length;

            entities.push({entityValue, entityType, entityStartIndex, entityEndIndex});
        }

        return entities;
    }

    private registerGlobalEntities(sentenceEntities: any[], entitiesMap: Map<string, Luis.Entity>): void {
        sentenceEntities.forEach(entity => {
            let entityType: string = entity.entityType;
            let entitySubtype: string;

            let composedEntitySeparatorPosition = entityType.indexOf('::');
            if (composedEntitySeparatorPosition >= 0) {
                entitySubtype = entityType.substring(composedEntitySeparatorPosition + '::'.length);
                entityType = entityType.substring(0, composedEntitySeparatorPosition);
            }

            let luisEntity = entitiesMap.get(entityType);
            luisEntity = luisEntity || { name: entityType };

            if (entitySubtype) {
                luisEntity.children = luisEntity.children || [];
                if (luisEntity.children.indexOf(entitySubtype) === -1) {
                    luisEntity.children.push(entitySubtype);
                }
            }

            entitiesMap.set(entityType, luisEntity);
        });
    }

    private replaceRawEntityValues(sentence: string, entities: any[]) {
        let plainSentence = sentence;

        entities.forEach((entity) => {
            plainSentence = plainSentence.replace(`[${entity.entityValue}:${entity.entityType}]`, entity.entityValue);
        });

        return plainSentence;
    }

    private buildUtterance(sentence: string, intent: string, entities: any[]) {
        // separate non-word chars the same way MS does (ex. 'a,b,c' -> 'a , b , c')
        // ^\w\u00C0-\u017F means a not word, including accented chars (see http://stackoverflow.com/a/11550799/12388)
        let normalizedSentence = sentence.replace(/[^\w\u00C0-\u017F|_|\.]/g, capture => ' ' + capture + ' ');

        // omit non-word exceptions not handled by microsoft ('º' and 'ª')
        normalizedSentence = normalizedSentence.replace(' º ', 'º');
        normalizedSentence = normalizedSentence.replace(' ª ', 'ª');

        // replace multiple spaces with a single one and trim
        normalizedSentence = normalizedSentence.replace(/\s\s+/g, ' ');
        normalizedSentence = normalizedSentence.trim();

        let utterance: Luis.Utterance = {
            text: normalizedSentence,
            intent,
            entities: []
        };

        let from = 0;
        entities.forEach(entity => {
            let startPos = this.findWordPosition(entity.entityValue, normalizedSentence, from);
            let endPos = startPos + entity.entityValue.split(/\s/).length - 1;

            from = startPos + 1;

            utterance.entities.push({
                entity: entity.entityType,
                startPos,
                endPos
            });
        });

        return utterance;
    }

    private findWordPosition(word: string, sentence: string, from: number = 0): number {
        let tokens = sentence.split(/\s/).splice(from);

        // TODO This is an approximation.
        //      It do not cover cases where the entity appears in the sentence
        //      ex. "Santiago went to [Santiago Bernabeu:place]"
        let firstWord = word.split(/\s/)[0];
        let position = tokens.indexOf(firstWord) + from;

        return position;
    }
}
