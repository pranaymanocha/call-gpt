require('colors');
const EventEmitter = require('events');
const OpenAI = require('openai');
const tools = require('../functions/function-manifest');
const { CARRIE_DESCRIPTION, OUTPUT_GUIDELINES } = require('./prompts');

// Import all functions included in function manifest
// Note: the function name and file name must be the same
const availableFunctions = {};
tools.forEach((tool) => {
  let functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});


class GptService extends EventEmitter {
  constructor() {
    super();
    this.openai = new OpenAI();

    this.userContext = [
      { 'role': 'system', 'content': `ROLE: ${CARRIE_DESCRIPTION}\n\nOUTPUT GUIDELINES: ${OUTPUT_GUIDELINES}\n\n` 
      },
    ],
    this.partialResponseIndex = 0;
  }

  // Add the callSid to the chat context in case
  // ChatGPT decides to transfer the call.
  setCallSid (callSid) {
    this.userContext.push({ 'role': 'system', 'content': `callSid: ${callSid}` });
  }

  validateFunctionArgs (args) {
    try {
      return JSON.parse(args);
    } catch (error) {
      console.log('Warning: Double function arguments returned by OpenAI:', args);
      // Seeing an error where sometimes we have two sets of args
      if (args.indexOf('{') != args.lastIndexOf('{')) {
        return JSON.parse(args.substring(args.indexOf(''), args.indexOf('}') + 1));
      }
    }
  }

  updateUserContext(name, role, text) {
    if (name !== 'user') {
      this.userContext.push({ 'role': role, 'name': name, 'content': text });
    } else {
      this.userContext.push({ 'role': role, 'content': text });
    }
  }

  async completion(text, interactionCount, role = 'user', name = 'user') {
    this.updateUserContext(name, role, text);

    // Step 1: Send user transcription to Chat GPT
    const response = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: this.userContext,
    });

    let completeResponse = '';
    let functionName = '';
    let functionArgs = '';
    let finishReason = '';

    function collectToolInformation(deltas) {
      let name = deltas.tool_calls[0]?.function?.name || '';
      if (name != '') {
        functionName = name;
      }
      let args = deltas.tool_calls[0]?.function?.arguments || '';
      if (args != '') {
        // args are streamed as JSON string so we need to concatenate all chunks
        functionArgs += args;
      }
    }

    const choice = response.choices[0];
    const content = choice.message?.content || '';
    const deltas = choice.message;
    finishReason = choice.finish_reason;

    // Step 2: check if GPT wanted to call a function
    if (deltas.tool_calls) {
      // Step 3: Collect the tokens containing function data
      collectToolInformation(deltas);
    }

    // need to call function on behalf of Chat GPT with the arguments it parsed from the conversation
    if (finishReason === 'tool_calls') {
      // parse JSON string of args into JSON object

      const functionToCall = availableFunctions[functionName];
      const validatedArgs = this.validateFunctionArgs(functionArgs);
      
      // Say a pre-configured message from the function manifest
      // before running the function.
      const toolData = tools.find(tool => tool.function.name === functionName);
      const say = toolData.function.say;

      this.emit('gptreply', {
        partialResponseIndex: null,
        partialResponse: say
      }, interactionCount);

      let functionResponse = await functionToCall(validatedArgs);

      // Step 4: send the info on the function call and function response to GPT
      this.updateUserContext(functionName, 'function', functionResponse);
      
      // call the completion function again but pass in the function response to have OpenAI generate a new assistant response
      await this.completion(functionResponse, interactionCount, 'function', functionName);
    } else {
      // Process the complete response
      completeResponse = content;
      const gptReply = { 
        partialResponseIndex: this.partialResponseIndex,
        partialResponse: completeResponse
      };

      this.emit('gptreply', gptReply, interactionCount);
      this.partialResponseIndex++;
    }

    this.userContext.push({'role': 'assistant', 'content': completeResponse});
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }
}

module.exports = { GptService };